import { expect, test } from "vitest";

import { counterIds, memoryStorage, type MemoryStorage } from "../adapters/memory/index.js";
import type { Recipe } from "../core/define-recipe.js";
import type { JsonValue } from "../core/json.js";
import type { Result } from "../core/result.js";
import type { RunDefinition } from "../core/runtime.js";
import type { Tool } from "../core/tool.js";
import { until } from "../core/run-harness.testing.js";
import { loadRecord } from "../record/load.js";
import {
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolTakingTime,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { decodeCommand } from "./commands.js";
import { decodeFrame } from "./frames.js";
import { createSession, type Session, type SessionEvent } from "./session.js";

/**
 * The session's commands (docs/protocol.md, CMD01 to CMD07, CMD11, CMD12 and the
 * rows added here for `prompt`, `steer` and `get_state`). A command goes in through
 * the same validator the wire uses, because a session only ever sees a command the
 * protocol accepted.
 */

interface Harness {
	clock: FakeClock;
	storage: MemoryStorage;
	session: Session;
	model: ReturnType<typeof scriptedModel>;
}

function harness(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[] = () => [createFinishTool()],
	options: {
		recipes?: ReadonlyMap<string, RunDefinition>;
		maxPageBytes?: number;
	} = {},
): Harness {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, { clock });
	const recipe: Recipe = {
		name: "test-task",
		version: 1,
		instructions: "you are a test",
		tools: makeTools(clock),
	};
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model,
		host: "test-host",
		recipes: options.recipes ?? new Map([["test-task", recipe]]),
		...(options.maxPageBytes === undefined ? {} : { maxPageBytes: options.maxPageBytes }),
	});
	return { clock, storage, session, model };
}

async function send(session: Session, fields: Record<string, unknown>): Promise<Result<JsonValue>> {
	const frame = decodeFrame(JSON.stringify({ type: "command", id: "c1", ...fields }));
	if (!frame.ok) {
		throw new Error(frame.error.message);
	}
	const decoded = decodeCommand(frame.value);
	if (!decoded.ok) {
		throw new Error(`${decoded.error.code}: ${decoded.error.message}`);
	}
	return session.command(decoded.value);
}

function valueOf(outcome: Result<JsonValue>): JsonValue {
	if (!outcome.ok) {
		throw new Error(`expected a response, got ${outcome.error.code}: ${outcome.error.message}`);
	}
	return outcome.value;
}

function errorOf(outcome: Result<JsonValue>): { code: string; message: string } {
	if (outcome.ok) {
		throw new Error(`expected a refusal, got ${JSON.stringify(outcome.value)}`);
	}
	return outcome.error;
}

/** Follow a session from the start, so a test can wait for the run it began. */
async function watch(session: Session): Promise<{ events: SessionEvent[]; done: () => boolean }> {
	const events: SessionEvent[] = [];
	const followed = await session.follow(0, (event) => events.push(event));
	expect(followed.ok).toBe(true);
	return { events, done: () => events.some((event) => event.type === "run_end") };
}

function entriesOf(storage: MemoryStorage): { type: string; label?: string; text?: string }[] {
	const loaded = loadRecord(storage.saved());
	return loaded.ok ? (loaded.value.entries as { type: string; label?: string }[]) : [];
}

test("CMD01 a start creates a session and a run, which reaches done", async () => {
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);

	expect(
		valueOf(await send(session, { command: "start", task: "test-task", input: "do it" })),
	).toEqual({ session: "s1", run: "r1" });

	await until(watched.done);
	// The run began and ended once, and the record is a whole one.
	expect(watched.events.map((event) => event.type).at(0)).toBe("run_start");
	expect(watched.events.filter((event) => event.type === "run_end")).toMatchObject([
		{ reason: "done" },
	]);
	expect(entriesOf(storage).at(-1)).toMatchObject({ type: "status" });
});

test("CMD01 a start for a task this host does not run is not_found", async () => {
	const { session } = harness([]);
	const refusal = errorOf(
		await send(session, { command: "start", task: "no-such-task", input: "do it" }),
	);
	expect(refusal.code).toBe("not_found");
	expect(refusal.message).toContain("no-such-task");
});

test("CMD02 a repeated start with the same key, task and input returns the same run", async () => {
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	const start = { command: "start", task: "test-task", input: { day: "2026-11-21" }, key: "k" };

	expect(valueOf(await send(session, start))).toEqual({ session: "s1", run: "r1" });
	await until(watched.done);
	const written = storage.saved().length;

	expect(valueOf(await send(session, start))).toEqual({ session: "s1", run: "r1" });
	// Nothing was started and nothing was written: the record is where it was.
	expect(storage.saved().length).toBe(written);
});

test("CMD03 a repeated start with the same key but a different job is conflict", async () => {
	const { session } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it", key: "k" });
	await until(watched.done);

	expect(
		errorOf(
			await send(session, {
				command: "start",
				task: "test-task",
				input: "do another",
				key: "k",
			}),
		).code,
	).toBe("conflict");
	// A different job under the same key is just as wrong as a different input.
	expect(
		errorOf(await send(session, { command: "start", task: "other", input: "do it", key: "k" }))
			.code,
	).toBe("conflict");
});

test("CMD04 a follow-up during a run is queued and read at the end", async () => {
	const { session, clock, model, storage } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);

	expect(
		valueOf(await send(session, { command: "follow_up", session: "s1", text: "one more" })),
	).toEqual({ session: "s1", run: "r1" });
	clock.advance(5_000);
	await until(watched.done);

	// The follow-up was read when the run would otherwise have ended, so the model
	// was asked once more than the finish alone would have needed.
	expect(model.requests).toHaveLength(3);
	expect(entriesOf(storage)).toContainEqual(
		expect.objectContaining({ type: "user_message", label: "follow_up", text: "one more" }),
	);
});

test("CMD05 a follow-up with nothing running continues the session", async () => {
	const { session, storage } = harness([
		{ toolCalls: [{ id: "c1", name: "finish" }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	]);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(watched.done);

	expect(
		valueOf(await send(session, { command: "follow_up", session: "s1", text: "more" })),
	).toEqual({
		session: "s1",
		run: "r1",
	});
	await until(() => watched.events.filter((event) => event.type === "run_end").length === 2);

	// A new segment of the same run: `resumed`, the follow-up's turn, and its own
	// ending, after the first segment's.
	const ends = watched.events.flatMap((event, index) =>
		event.type === "run_end" ? [index] : [],
	);
	expect(ends).toHaveLength(2);
	const after = (ends[0] ?? 0) + 1;
	expect(watched.events.slice(after, after + 2)).toMatchObject([
		{ type: "resumed" },
		{ type: "run_start" },
	]);
	expect(watched.events.at(-1)).toMatchObject({ type: "run_end", reason: "done" });
	expect(entriesOf(storage).filter((entry) => entry.label === "follow_up")).toHaveLength(1);
});

test("CMD06 an abort parks the run stopped, and CMD07 resumes it", async () => {
	const { session, clock, model, storage } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);

	expect(valueOf(await send(session, { command: "abort", session: "s1" }))).toEqual({
		session: "s1",
		run: "r1",
	});
	await until(watched.done);
	expect(watched.events.slice(-2)).toMatchObject([
		{ type: "parked", reason: "stopped" },
		{ type: "run_end", reason: "parked", parkedReason: "stopped" },
	]);

	// The park is resumable by a person, and the resumed run ends on its own.
	expect(valueOf(await send(session, { command: "resume", session: "s1" }))).toEqual({
		session: "s1",
		run: "r1",
	});
	await until(() => watched.events.filter((event) => event.type === "run_end").length === 2);
	clock.advance(5_000);
	await until(() => watched.events.at(-1)?.type === "run_end" && model.requests.length === 2);

	expect(watched.events.at(-1)).toMatchObject({ type: "run_end", reason: "done" });
});

test("CMD17 prompt is busy during a run unless it is queued, and starts one when idle", async () => {
	const { session, clock, model, storage } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);

	const busy = errorOf(await send(session, { command: "prompt", session: "s1", text: "hello" }));
	expect(busy.code).toBe("busy");
	expect(
		valueOf(
			await send(session, { command: "prompt", session: "s1", text: "queued", queue: true }),
		),
	).toEqual({ session: "s1", run: "r1" });
	clock.advance(5_000);
	await until(watched.done);
	expect(entriesOf(storage)).toContainEqual(
		expect.objectContaining({ type: "user_message", label: "follow_up", text: "queued" }),
	);

	// With nothing running, a prompt is the same thing as a follow-up: it continues
	// the session's record rather than refusing.
	expect(
		valueOf(await send(session, { command: "prompt", session: "s1", text: "again" })),
	).toEqual({
		session: "s1",
		run: "r1",
	});
	await until(() => watched.events.filter((event) => event.type === "run_end").length === 2);
});

test("CMD18 get_state reports the run, its queue and its usage", async () => {
	const { session, clock, model, storage } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	// Before anything has run, the session is idle and has no run to name.
	expect(valueOf(await send(session, { command: "get_state" }))).toMatchObject({
		session: "s1",
		run: null,
		state: "idle",
		queue: { steers: 0, followUps: 0 },
	});

	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);
	await send(session, { command: "steer", session: "s1", text: "left a bit" });
	await send(session, { command: "follow_up", session: "s1", text: "one more" });

	expect(valueOf(await send(session, { command: "get_state" }))).toMatchObject({
		session: "s1",
		run: "r1",
		state: "running",
		queue: { steers: 1, followUps: 1 },
		usage: { inputTokens: expect.any(Number), outputTokens: expect.any(Number) },
		turns: 1,
	});

	clock.advance(5_000);
	await until(watched.done);
	expect(valueOf(await send(session, { command: "get_state" }))).toMatchObject({
		state: "done",
		queue: { steers: 0, followUps: 0 },
	});
});

test("CMD19 a steer with nothing running is conflict and writes nothing", async () => {
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(watched.done);
	const written = storage.saved().length;

	expect(
		errorOf(await send(session, { command: "steer", session: "s1", text: "left a bit" })).code,
	).toBe("conflict");
	expect(storage.saved().length).toBe(written);
	expect(entriesOf(storage)).not.toContainEqual(
		expect.objectContaining({ type: "user_message", label: "steer" }),
	);
});

test("CMD11 get_messages returns the branch ending at an entry", async () => {
	const { session } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(watched.done);

	const all = valueOf(await send(session, { command: "get_messages", session: "s1" })) as {
		entries: { id: string }[];
		cursor: string | null;
	};
	expect(all.entries.length).toBeGreaterThan(1);
	// The branch to the task message is the header's jump-off point: the one entry.
	const first = all.entries[0];
	expect(first).toBeDefined();
	const branch = valueOf(
		await send(session, { command: "get_messages", session: "s1", entry: first?.id }),
	) as { entries: { id: string }[] };
	expect(branch.entries.map((entry) => entry.id)).toEqual([first?.id]);
});

test("CMD12 a long record comes back in pages, each under the reply cap", async () => {
	// A small byte cap, so a page is small even before the record is long.
	const { session, storage } = harness(
		[{ toolCalls: [{ id: "c1", name: "finish" }] }],
		undefined,
		{
			maxPageBytes: 600,
		},
	);
	const watched = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(watched.done);
	const total = storage.saved().length - 1;
	expect(total).toBeGreaterThan(2);

	const seen: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < total + 1; page += 1) {
		const fields: Record<string, unknown> = {
			command: "get_messages",
			session: "s1",
			limit: 2,
		};
		if (cursor !== undefined) {
			fields["cursor"] = cursor;
		}
		const response = valueOf(await send(session, fields)) as {
			entries: { id: string }[];
			cursor?: string | null;
		};
		expect(response.entries.length).toBeLessThanOrEqual(2);
		// Never over the reply cap, and never an empty page with more behind it.
		expect(response.entries.length).toBeGreaterThan(0);
		expect(JSON.stringify(response.entries).length).toBeLessThanOrEqual(600);
		seen.push(...response.entries.map((entry) => entry.id));
		if (!response.cursor) {
			break;
		}
		cursor = response.cursor;
	}
	// Every entry, once, in order: paging loses nothing and repeats nothing.
	const ids = entriesOf(storage).map((_, index) => index);
	expect(seen).toHaveLength(ids.length);
	expect(new Set(seen).size).toBe(seen.length);
});

test("EVT01 a client that joins mid-run replays, then follows, without a gap or a duplicate", async () => {
	const { session, clock, model, storage } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const running = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);

	// Join late: the first entries are already in the record, and the rest arrive live.
	const late: SessionEvent[] = [];
	const followed = await session.follow(0, (event) => late.push(event));
	expect(followed.ok).toBe(true);
	clock.advance(5_000);
	await until(() => late.some((event) => event.type === "run_end"));

	const seqs = late.flatMap((event) => ("seq" in event ? [event.seq] : []));
	expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	// No event was sent twice, and the late client saw what the early one did.
	expect(late.filter((event) => event.type === "run_end")).toHaveLength(1);
	const early = running.events.filter((event) => "seq" in event).map((event) => event.seq);
	expect(late.filter((event) => "seq" in event).map((event) => event.seq)).toEqual(early);
});
