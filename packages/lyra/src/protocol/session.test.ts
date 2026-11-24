import { expect, test } from "vitest";

import { counterIds, memoryStorage, type MemoryStorage } from "../adapters/memory/index.js";
import type { Recipe } from "../core/define-recipe.js";
import { createProposeTool } from "../core/propose.js";
import type { JsonValue } from "../core/json.js";
import type { Result } from "../core/result.js";
import type { RunDefinition } from "../core/runtime.js";
import type { Tool } from "../core/tool.js";
import { until } from "../core/run-harness.testing.js";
import { loadRecord } from "../record/load.js";
import { activePath } from "../record/replay.js";
import {
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolAsking,
	toolReturning,
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
		summaries?: readonly ScriptedTurn[];
	} = {},
): Harness {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, {
		clock,
		...(options.summaries === undefined ? {} : { summaries: options.summaries }),
	});
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

/** One command through the same validator the wire uses. */
function decodeCommandOf(fields: Record<string, unknown>): import("./commands.js").Command {
	const frame = decodeFrame(JSON.stringify({ type: "command", id: "c1", ...fields }));
	if (!frame.ok) {
		throw new Error(frame.error.message);
	}
	const decoded = decodeCommand(frame.value);
	if (!decoded.ok) {
		throw new Error(`${decoded.error.code}: ${decoded.error.message}`);
	}
	return decoded.value;
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

test("EVT05 a client that reconnects with its last seq is sent only what it missed", async () => {
	// The record is the buffer (decision 86): a client that reconnects asks for what
	// follows the last entry it saw, and never for a live-only event from before.
	const { session, clock, model } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const first = await watch(session);
	await send(session, { command: "start", task: "test-task", input: "do it" });
	await until(() => model.requests.length === 1);
	await until(() => first.events.length >= 3);

	const seen = first.events.at(-1);
	expect(seen).toBeDefined();
	const last = seen !== undefined && "seq" in seen ? seen.seq : 0;

	const reconnected: SessionEvent[] = [];
	const followed = await session.follow(last, (event) => reconnected.push(event));
	expect(followed.ok).toBe(true);
	clock.advance(5_000);
	await until(() => reconnected.some((event) => event.type === "run_end"));

	// Nothing at or before the last entry the client had, and nothing out of order.
	const seqs = reconnected.flatMap((event) => ("seq" in event ? [event.seq] : []));
	expect(seqs.every((seq) => seq > last)).toBe(true);
	expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
	expect(reconnected.filter((event) => event.type === "run_end")).toHaveLength(1);
});

test("CMD02 two starts that overlap answer the same run and write one header", async () => {
	// A retry can arrive while the first attempt is still writing its header. The
	// session must answer it as the same run, not start a rival one (decision 131).
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	const start = { command: "start", task: "test-task", input: "do it", key: "k" };
	const [first, second] = await Promise.all([send(session, start), send(session, start)]);

	expect(valueOf(first)).toEqual({ session: "s1", run: "r1" });
	expect(valueOf(second)).toEqual({ session: "s1", run: "r1" });
	await until(watched.done);

	const headers = storage.saved().filter((line) => line.includes('"type":"header"'));
	expect(headers).toHaveLength(1);
});

test("CMD03 two overlapping starts with different jobs cannot both start", async () => {
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const watched = await watch(session);
	const [first, second] = await Promise.all([
		send(session, { command: "start", task: "test-task", input: "do it", key: "k" }),
		send(session, { command: "start", task: "test-task", input: "do another", key: "k" }),
	]);
	await until(watched.done);
	// One of them started the run; the other is a conflict, and only one header landed.
	expect([first.ok, second.ok].filter((ok) => ok)).toHaveLength(1);
	expect([first, second].flatMap((outcome) => (outcome.ok ? [] : [outcome.error.code]))).toEqual([
		"conflict",
	]);
	expect(storage.saved().filter((line) => line.includes('"type":"header"'))).toHaveLength(1);
});

test("CMD20 compact summarizes the record now, and is busy while a run is active", async () => {
	const recipe: Recipe = {
		name: "test-task",
		version: 1,
		instructions: "you are a test",
		// A tiny keep budget, so a short record has something to cut.
		compaction: { keepTokens: 1 },
		tools: [toolReturning("read", "x".repeat(400)), createFinishTool()],
	};
	const { session, storage, model } = harness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
		],
		() => [toolReturning("read", "x".repeat(400)), createFinishTool()],
		{ recipes: new Map([["test-task", recipe]]), summaries: [{ text: "the summary" }] },
	);
	const watched = await watch(session);

	valueOf(await send(session, { command: "start", task: "test-task", input: "do it" }));
	// While the run is mid-step, a compaction would change the view under it.
	expect(errorOf(await send(session, { command: "compact", session: "s1" })).code).toBe("busy");
	await until(watched.done);

	const compacted = valueOf(
		await send(session, { command: "compact", session: "s1", instructions: "keep the ids" }),
	);
	expect(compacted).toEqual({ session: "s1", run: "r1", compacted: true });

	// The entry is in the record, marked as a person's doing, and the summary's
	// instructions carried theirs.
	const written = storage.saved();
	const loaded = loadRecord(written);
	expect(loaded.ok).toBe(true);
	const entry = loaded.ok
		? loaded.value.entries.find((each) => each.type === "compaction")
		: undefined;
	expect(entry).toMatchObject({ type: "compaction", trigger: "manual", summary: "the summary" });
	const request = model.requests.filter((each) => each.purpose === "compaction").at(0);
	expect(request?.system).toContain("keep the ids");

	// The event reaches a client the same way a reconnect would replay it.
	expect(watched.events.filter((event) => event.type === "compaction")).toHaveLength(1);

	// A second compaction has nothing left to cut, which is not a failure.
	expect(valueOf(await send(session, { command: "compact", session: "s1" }))).toEqual({
		session: "s1",
		run: "r1",
		compacted: false,
	});
	// A session with no record at all has nothing to compact.
	const empty = harness([]);
	expect(errorOf(await send(empty.session, { command: "compact", session: "s1" })).code).toBe(
		"not_found",
	);
});

/** A recipe whose one tool asks, which is what every test here needs. */
function asking(turns: readonly ScriptedTurn[]): Harness {
	return harness(
		turns,
		() => [toolReturning("write", "wrote one line", { policy: "ask" }), createFinishTool()],
		{ summaries: [] },
	);
}

const ASK_TURNS: ScriptedTurn[] = [
	{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
	{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
];

/** The request the session is waiting on, once the run has parked. */
async function waitingRequest(storage: MemoryStorage): Promise<Record<string, unknown>> {
	await until(() => entriesOf(storage).some((entry) => entry.type === "request"));
	const request = entriesOf(storage).find((entry) => entry.type === "request");
	if (request === undefined) {
		throw new Error("the run never asked");
	}
	return request as Record<string, unknown>;
}

function finished(storage: MemoryStorage): boolean {
	return storage.saved().some((line) => line.includes('"state":"done"'));
}

test("REQ02 a request with no client connected is listed and answerable later", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);

	// Nothing was ever watching, which is the whole point of a durable request.
	const listed = valueOf(await send(session, { command: "list_pending", session: "s1" }));
	expect(listed).toMatchObject({
		session: "s1",
		requests: [
			{
				request: request["request"],
				kind: "approve",
				callId: "c1",
				tool: "write",
			},
		],
		proposals: [],
	});

	const answered = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
	});
	expect(answered.ok).toBe(true);
	await until(() => finished(storage));
	// One answer, one result, and the run went on to its done-check.
	expect(entriesOf(storage).filter((entry) => entry.type === "request_answered")).toHaveLength(1);
});

test("REQ03 a second answer to the same request is conflict, and the first stands", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);

	const first = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: false,
	});
	expect(first.ok).toBe(true);
	const second = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
	});
	expect(second.ok ? "" : second.error.code).toBe("conflict");
	expect(entriesOf(storage).filter((entry) => entry.type === "request_answered")).toHaveLength(1);
	expect(entriesOf(storage).find((entry) => entry.type === "request_answered")).toMatchObject({
		decision: "deny",
	});
});

test("REQ04 an answer to a request this session never asked is not_found", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await waitingRequest(storage);

	const unknown = await session.respond({ session: "s1", request: "auth-nope", ok: true });
	expect(unknown.ok ? "" : unknown.error.code).toBe("not_found");

	// A session with no record at all has nothing to answer either.
	const empty = asking(ASK_TURNS);
	const nothing = await empty.session.respond({ session: "s1", request: "auth-nope", ok: true });
	expect(nothing.ok ? "" : nothing.error.code).toBe("not_found");
});

test("CMD08 resume is busy while a person is deciding, and the ids are named", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);
	await until(() => !storage.saved().some((line) => line.includes('"state":"running"')));

	const refused = errorOf(await send(session, { command: "resume", session: "s1" }));
	expect(refused.code).toBe("busy");
	expect(refused.message).toContain(String(request["request"]));
});

test("CMD09 list_pending is empty once the answer is in, and get_state counts what waits", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);

	// `get_state` counts what is waiting, so a viewer knows to glow (decision 36).
	expect(valueOf(await send(session, { command: "get_state", session: "s1" }))).toMatchObject({
		pending: 1,
	});

	await session.respond({ session: "s1", request: String(request["request"]), ok: false });
	await until(() => finished(storage));

	const listed = valueOf(await send(session, { command: "list_pending", session: "s1" }));
	expect(listed).toMatchObject({ requests: [] });
	expect(valueOf(await send(session, { command: "get_state", session: "s1" }))).toMatchObject({
		pending: 0,
	});
});

test("REQ06 a wake behind a pending request does not deliver the run", async () => {
	// A finished job's wake must not carry the model past a question a person has
	// not answered (decision 34's queueing rule).
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await waitingRequest(storage);
	await until(() => !storage.saved().some((line) => line.includes('"state":"running"')));

	const runsBefore = entriesOf(storage).filter(
		(entry) => entry.type === "assistant_message",
	).length;
	const woken = await send(session, { command: "resume", session: "s1" });
	expect(errorOf(woken).code).toBe("busy");
	expect(entriesOf(storage).filter((entry) => entry.type === "assistant_message")).toHaveLength(
		runsBefore,
	);
	// The request is still the thing being waited on.
	expect(entriesOf(storage).filter((entry) => entry.type === "request_answered")).toHaveLength(0);
});

test("REQ06 the host's alarm behind a pending request leaves it parked", async () => {
	const { session, storage } = asking(ASK_TURNS);
	const started = valueOf(
		await send(session, { command: "start", task: "test-task", input: "go" }),
	) as { run: string };
	await waitingRequest(storage);
	await until(() => !storage.saved().some((line) => line.includes('"state":"running"')));

	const before = entriesOf(storage).filter((entry) => entry.type === "assistant_message").length;
	const woken = await session.wake(started.run);
	expect(woken.ok).toBe(true);
	await until(() => entriesOf(storage).at(-1)?.type === "status");
	expect(entriesOf(storage).filter((entry) => entry.type === "assistant_message")).toHaveLength(
		before,
	);
	expect(entriesOf(storage).filter((entry) => entry.type === "request_answered")).toHaveLength(0);
});

test("REQ04 an expired request is not_found, even after the clock answered it", async () => {
	// The wake writes the timeout's own deny. A person who arrives afterwards is
	// looking at an expired id, which decision 85 says is `not_found`, not a second
	// answer to something still open.
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);
	const parent = (JSON.parse(storage.saved().at(-1) ?? "{}") as { id?: string }).id ?? null;
	const timedOut = await storage.append(
		JSON.stringify({
			type: "request_answered",
			id: "e_expired",
			parent,
			ts: 100,
			request: String(request["request"]),
			decision: "deny",
			timedOut: true,
		}),
	);
	expect(timedOut.ok).toBe(true);

	const late = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
	});
	expect(late.ok ? "" : late.error.code).toBe("not_found");
});

test("REQ06 a prompt or a follow_up behind a pending request is busy, not dropped", async () => {
	// Both would continue the record, which a run waiting for a person cannot do;
	// answering `ok` and writing nothing would lose what the person said.
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await waitingRequest(storage);
	await until(() => !storage.saved().some((line) => line.includes('"state":"running"')));
	const written = storage.saved().length;

	for (const command of ["prompt", "follow_up"]) {
		const refused = errorOf(
			await send(session, { command, session: "s1", text: "one more thing" }),
		);
		expect({ command, code: refused.code }).toEqual({ command, code: "busy" });
		expect({ command, names: refused.message.includes("waiting for a person") }).toEqual({
			command,
			names: true,
		});
	}
	// Nothing was written, and the text is not on the record pretending it was read.
	expect(storage.saved()).toHaveLength(written);
});

test("APR15 a choice can be denied, and an approval cannot be answered with a text", async () => {
	// Decision 34 gives every request a deny, and the timeout denies a choice too;
	// only approving a choice has to name one of the options it offered.
	const clock = fakeClock();
	const storage = memoryStorage();
	const choosing: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "choose", args: {} }] },
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const model = scriptedModel(choosing, { clock });
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model,
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						toolAsking("choose", {
							kind: "choice",
							title: "Which one?",
							message: "Pick one.",
							options: [
								{ id: "a", label: "A" },
								{ id: "b", label: "B" },
							],
						}),
						createFinishTool(),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => storage.saved().some((line) => line.includes('"type":"request"')));
	const request = entriesOf(storage).find((entry) => entry.type === "request");
	const id = String((request as { request?: string } | undefined)?.request ?? "");

	// The run has to have parked before an answer can continue it.
	await until(() => !storage.saved().some((line) => line.includes('"state":"running"')));
	const denied = await session.respond({
		session: "s1",
		request: id,
		ok: false,
		note: "none thanks",
	});
	expect(denied.ok).toBe(true);
	await until(() => storage.saved().some((line) => line.includes('"state":"done"')));
	expect(entriesOf(storage).find((entry) => entry.type === "request_answered")).toMatchObject({
		decision: "deny",
		note: "none thanks",
	});
});

test("APR15 an approval answered with a text is refused, and the call is untouched", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);

	const refused = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
		text: "here you are",
	});
	expect(refused.ok ? "" : refused.error.code).toBe("bad_request");
	expect(entriesOf(storage).filter((entry) => entry.type === "request_answered")).toHaveLength(0);
});

test("CMD10 PRP03 PRP04 PRP05 decide_proposal decides once, and refuses the second decision", async () => {
	// A proposal is a finished run's result: a person accepts or rejects it, the
	// decision is its own entry, and a second one conflicts (decisions 53, 85).
	const clock = fakeClock();
	const storage = memoryStorage();
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
	];
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => storage.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(storage).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");
	expect(id).not.toBe("");

	// The proposal and its decision are events a viewer can follow, from the record.
	const events = await session.replay(0);
	expect(events.ok ? events.value.filter((event) => event.type === "proposal") : []).toHaveLength(
		1,
	);

	// An open proposal is listed, with enough to decide it (CMD09).
	const listed = valueOf(await send(session, { command: "list_pending", session: "s1" }));
	expect(listed).toMatchObject({
		proposals: [{ proposal: id, payload: { verdict: "deny", score: 0.9 }, state: "open" }],
	});

	const decided = valueOf(
		await send(session, {
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "reject",
			note: "not our call",
		}),
	);
	expect(decided).toMatchObject({ session: "s1", proposal: id, decision: "reject" });
	expect(entriesOf(storage).find((entry) => entry.type === "proposal_decided")).toMatchObject({
		proposal: id,
		decision: "reject",
		note: "not our call",
	});

	const second = errorOf(
		await send(session, {
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "accept",
		}),
	);
	expect(second.code).toBe("conflict");
	const decided_events = await session.replay(0);
	expect(
		decided_events.ok
			? decided_events.value.filter((event) => event.type === "proposal_decided")
			: [],
	).toMatchObject([{ proposal: id, decision: "reject" }]);

	// An unknown proposal is not found, and the decided one leaves the list.
	expect(
		errorOf(
			await send(session, {
				command: "decide_proposal",
				session: "s1",
				proposal: "prop_nope",
				decision: "accept",
			}),
		).code,
	).toBe("not_found");
	expect(valueOf(await send(session, { command: "list_pending", session: "s1" }))).toMatchObject({
		proposals: [],
	});
});

test("CMD10 two decisions at once write one, and a decision waits for no run", async () => {
	// A decision is a write into a record a run may also be writing to, so it is
	// refused while a run is active and serialized against another decision; the
	// second command must not chain from a parent the first one has moved on from.
	const clock = fakeClock();
	const storage = memoryStorage();
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
	];
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => storage.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(storage).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	const frame = (decision: "accept" | "reject") => {
		const decoded = decodeFrame(
			JSON.stringify({
				type: "command",
				id: `c-${decision}`,
				command: "decide_proposal",
				session: "s1",
				proposal: id,
				decision,
			}),
		);
		if (!decoded.ok) {
			throw new Error(decoded.error.message);
		}
		const command = decodeCommand(decoded.value);
		if (!command.ok) {
			throw new Error(command.error.message);
		}
		return command.value;
	};

	const [first, second] = await Promise.all([
		session.command(frame("accept")),
		session.command(frame("reject")),
	]);
	expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
	expect(entriesOf(storage).filter((entry) => entry.type === "proposal_decided")).toHaveLength(1);
	// The one decision is on the active path, which is what `list_pending` reads.
	const loaded = loadRecord(storage.saved());
	expect(loaded.ok).toBe(true);
	const path = loaded.ok
		? (activePath(loaded.value.entries) as { type: string }[]).map((entry) => entry.type)
		: [];
	expect(path).toContain("proposal_decided");
});

/** A storage whose `append` can be held on one line, to open a race on purpose. */
function holdableStorage(inner: MemoryStorage) {
	let held: (() => void) | undefined;
	let armWhen: string | undefined;
	let holdReadAt: number | undefined;
	let reads = 0;
	return {
		slot: {
			append: async (line: string) => {
				if (armWhen !== undefined && line.includes(armWhen)) {
					await new Promise<void>((resolve) => {
						held = resolve;
					});
				}
				return inner.append(line);
			},
			read: async () => {
				reads += 1;
				if (holdReadAt !== undefined && reads === holdReadAt) {
					await new Promise<void>((resolve) => {
						held = resolve;
					});
				}
				return inner.read();
			},
			// The slot's optional shape, so a session sees the same storage it would
			// otherwise be given.
			...(inner.maxEntryBytes === undefined ? {} : { maxEntryBytes: inner.maxEntryBytes }),
			saved: () => inner.saved(),
		},
		/** Hold the next append whose line contains this text. */
		arm: (text: string): void => {
			armWhen = text;
		},
		/** Hold the nth read from now, which is where a resume sits while it claims. */
		holdRead: (nth: number): void => {
			reads = 0;
			holdReadAt = nth;
		},
		release: (): void => {
			armWhen = undefined;
			holdReadAt = undefined;
			held?.();
			held = undefined;
		},
	};
}

test("CMD10 a follow_up cannot slip in while a decision is being written", async () => {
	// A decision and a run both append to one record: a follow-up accepted between
	// the decision's read and its append would chain from the same parent and drop
	// one of the two branches off the active path, with no error to anyone.
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const session = createSession({
		id: "s1",
		storage: holding.slot,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
						createFinishTool(),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(inner).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	holding.arm('"type":"proposal_decided"');
	const deciding = session.command(
		decodeCommandOf({
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "accept",
		}),
	);
	// Let the decision reach its append, where it is holding the record.
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const slipped = await session.command(
		decodeCommandOf({ command: "follow_up", session: "s1", text: "one more thing" }),
	);
	const refused = slipped.ok ? "" : slipped.error.code;
	holding.release();
	expect({ refused, decided: (await deciding).ok }).toEqual({ refused: "busy", decided: true });
	expect(inner.saved().some((line) => line.includes("one more thing"))).toBe(false);
});

test("CMD10 a decision is refused while a run is writing the record", async () => {
	// The other half of the same race: a run that is mid-step is writing too, so the
	// decision waits rather than chaining from a parent the run will move past.
	const clock = fakeClock();
	const storage = memoryStorage();
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
		{ toolCalls: [{ id: "c2", name: "slow", args: {} }] },
		{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
	];
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
						toolTakingTime("slow", 5_000, clock),
						createFinishTool(),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => storage.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(storage).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	// A follow-up starts a run whose next turn sits in a slow tool.
	valueOf(await send(session, { command: "prompt", session: "s1", text: "go on", queue: true }));
	await until(() => storage.saved().some((line) => line.includes('"name":"slow"')));

	const refused = errorOf(
		await send(session, {
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "accept",
		}),
	);
	expect(refused.code).toBe("busy");
	expect(entriesOf(storage).filter((entry) => entry.type === "proposal_decided")).toHaveLength(0);
	clock.advance(5_000);
});

test("CMD20 a start or a resume is refused while a decision is being written", async () => {
	// The lock has to hold in both directions, or the branch that is written second
	// falls off the active path (found in review).
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
	];
	const session = createSession({
		id: "s1",
		storage: holding.slot,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(inner).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	holding.arm('"type":"proposal_decided"');
	const deciding = session.command(
		decodeCommandOf({
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "accept",
		}),
	);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}

	const resumed = await session.command(decodeCommandOf({ command: "resume", session: "s1" }));
	const prompted = await session.command(
		decodeCommandOf({ command: "prompt", session: "s1", text: "and then", queue: true }),
	);
	holding.release();
	expect({ resumed: resumed.ok ? "" : resumed.error.code }).toEqual({ resumed: "busy" });
	expect({ prompted: prompted.ok ? "" : prompted.error.code }).toEqual({ prompted: "busy" });
	expect((await deciding).ok).toBe(true);
});

/** A session whose one tool asks and whose recipe can propose, for the answer paths. */
function claiming(clock: FakeClock, inner: MemoryStorage) {
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "deny", score: 0.9 }, evidence: ["post:1"] },
				},
			],
		},
		{ toolCalls: [{ id: "c2", name: "write", args: {} }] },
		{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
	];
	return createSession({
		id: "s1",
		storage: inner,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
						toolReturning("write", "wrote one line", { policy: "ask" }),
						createFinishTool(),
					],
				},
			],
		]),
	});
}

test("REQ03 two answers at once write one, and the other is refused", async () => {
	// An answer is a read, a check and an append like a decision, so two of them
	// arriving together must not both pass the check (the approvals path of the same
	// race the decision lock covers).
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const session = claiming(clock, holding.slot);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	valueOf(await send(session, { command: "prompt", session: "s1", text: "go on", queue: true }));
	await until(() => inner.saved().some((line) => line.includes('"type":"request"')));
	const request = entriesOf(inner).find((entry) => entry.type === "request");
	const id = String((request as { request?: string } | undefined)?.request ?? "");
	await until(() => !inner.saved().some((line) => line.slice(-30).includes('"running"')));

	holding.arm('"type":"request_answered"');
	const first = session.respond({ session: "s1", request: id, ok: true });
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const second = await session.respond({ session: "s1", request: id, ok: false });
	holding.release();
	expect({ first: (await first).ok, second: second.ok ? "" : second.error.code }).toEqual({
		first: true,
		second: "busy",
	});
	expect(entriesOf(inner).filter((entry) => entry.type === "request_answered")).toHaveLength(1);
});

test("CMD10 a decision cannot chain from a parent an answer is about to move past", async () => {
	// The approvals answer path and a decision both append; the one that lands second
	// would fall off the active path, so the second is refused while the first writes.
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const session = claiming(clock, holding.slot);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(inner).find((entry) => entry.type === "proposal");
	const proposalId = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");
	valueOf(await send(session, { command: "prompt", session: "s1", text: "go on", queue: true }));
	await until(() => inner.saved().some((line) => line.includes('"type":"request"')));
	const request = entriesOf(inner).find((entry) => entry.type === "request");
	const id = String((request as { request?: string } | undefined)?.request ?? "");
	await until(() => !inner.saved().some((line) => line.slice(-30).includes('"running"')));

	holding.arm('"type":"request_answered"');
	const answering = session.respond({ session: "s1", request: id, ok: false });
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const decided = await session.command(
		decodeCommandOf({
			command: "decide_proposal",
			session: "s1",
			proposal: proposalId,
			decision: "accept",
		}),
	);
	holding.release();
	expect({ decided: decided.ok ? "" : decided.error.code }).toEqual({ decided: "busy" });
	expect((await answering).ok).toBe(true);
});

test("CMD20 a compaction waits for a decision being written", async () => {
	// A compaction appends an entry of its own, so it claims the record like the
	// others: two writers chaining from one parent is the same loss (found in review).
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const session = claiming(clock, holding.slot);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	const proposal = entriesOf(inner).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	holding.arm('"type":"proposal_decided"');
	const deciding = session.command(
		decodeCommandOf({
			command: "decide_proposal",
			session: "s1",
			proposal: id,
			decision: "accept",
		}),
	);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const compacted = await session.command(decodeCommandOf({ command: "compact", session: "s1" }));
	holding.release();
	expect({ compacted: compacted.ok ? "" : compacted.error.code }).toEqual({ compacted: "busy" });
	expect((await deciding).ok).toBe(true);
});

test("REQ05 a wake that lands during another command waits for it instead of being lost", async () => {
	// The alarm has nobody to report `busy` to: the wake it carries is the only thing
	// that will ever deny a timed request, so it queues behind the claim (found in
	// review).
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const session = claiming(clock, holding.slot);
	const started = valueOf(
		await send(session, { command: "start", task: "test-task", input: "go" }),
	) as { run: string };
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	valueOf(await send(session, { command: "prompt", session: "s1", text: "go on", queue: true }));
	await until(() => inner.saved().some((line) => line.includes('"type":"request"')));
	const request = entriesOf(inner).find((entry) => entry.type === "request");
	const id = String((request as { request?: string } | undefined)?.request ?? "");
	await until(() => !inner.saved().some((line) => line.slice(-30).includes('"running"')));

	holding.arm('"type":"request_answered"');
	const answering = session.respond({ session: "s1", request: id, ok: false });
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}

	// The alarm arrives while the answer is still being written.
	let settled = false;
	const waking = session.wake(started.run);
	void waking.then(() => {
		settled = true;
	});
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	expect(settled).toBe(false);

	holding.release();
	const woken = await waking;
	expect({ woken: woken.ok, answered: (await answering).ok }).toEqual({
		woken: true,
		answered: true,
	});
});

test("REQ05 a wake queued behind a resume is woken when the resume finishes", async () => {
	// Only `release` wakes a waiter, so a command that clears the claim by hand would
	// leave a queued alarm hanging — the same lost timeout by another route.
	const clock = fakeClock();
	const inner = memoryStorage();
	const holding = holdableStorage(inner);
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const session = createSession({
		id: "s1",
		storage: holding.slot,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [toolTakingTime("slow", 5_000, clock), createFinishTool()],
				},
			],
		]),
	});
	const started = valueOf(
		await send(session, { command: "start", task: "test-task", input: "go" }),
	) as { run: string };
	await until(() => inner.saved().some((line) => line.includes('"name":"slow"')));
	valueOf(await send(session, { command: "abort", session: "s1" }));
	await until(() => inner.saved().some((line) => line.includes('"reason":"stopped"')));
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}

	// The resume claims the record and then waits on its first read of it; a wake
	// arriving in that window has to queue, not be dropped.
	holding.holdRead(2);
	const resumed = session.command(decodeCommandOf({ command: "resume", session: "s1" }));
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const waking = session.wake(started.run);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	holding.release();

	const answer = await resumed;
	expect({ resumed: answer.ok ? "" : answer.error.code, woken: (await waking).ok }).toEqual({
		resumed: "",
		woken: true,
	});
	clock.advance(5_000);
});

test("REQ03 an answer too big for one record entry is bad_request, and writes nothing", async () => {
	const { session, storage } = asking(ASK_TURNS);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	const request = await waitingRequest(storage);
	const before = storage.saved().length;

	// The line cap is twice the entry cap, so a note this long reaches the session.
	// It is the client's mistake, and a 500 would tell the client to retry the same thing.
	const refused = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
		note: "x".repeat(1.5 * 1024 * 1024),
	});
	expect(refused.ok ? "" : refused.error.code).toBe("bad_request");
	expect(storage.saved()).toHaveLength(before);

	// The request is still open, so the same person can answer again, shorter.
	const again = await session.respond({
		session: "s1",
		request: String(request["request"]),
		ok: true,
	});
	expect(again.ok).toBe(true);
});

test("CMD10 a decision that read the record before another one landed does not decide twice", async () => {
	// The check for an earlier decision reads the record, so it must read it after the
	// session holds the write claim: a read made before the claim can be a snapshot
	// from before the other decision, and then both decisions are written (decision 53).
	const clock = fakeClock();
	const inner = memoryStorage();
	let hold: Promise<void> | undefined;
	const storage: MemoryStorage = {
		...inner,
		append: (line) => inner.append(line),
		read: async () => {
			// The snapshot is taken now and handed back late, as a slow read would.
			const snapshot = await inner.read();
			const gate = hold;
			hold = undefined;
			if (gate !== undefined) {
				await gate;
			}
			return snapshot;
		},
	};
	const session = createSession({
		id: "s1",
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(
			[
				{
					toolCalls: [
						{
							id: "c1",
							name: "propose",
							args: {
								payload: { verdict: "deny", score: 0.9 },
								evidence: ["post:1"],
							},
						},
					],
				},
			],
			{ clock },
		),
		host: "test-host",
		recipes: new Map([
			[
				"test-task",
				{
					name: "test-task",
					version: 1,
					instructions: "you are a test",
					tools: [
						createProposeTool({
							payload: {
								type: "object",
								properties: {
									verdict: { type: "string" },
									score: { type: "number" },
								},
								required: ["verdict", "score"],
							},
						}),
					],
				},
			],
		]),
	});
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => inner.saved().some((line) => line.includes('"type":"proposal"')));
	// Let the run finish writing before the decisions start.
	await until(() => inner.saved().some((line) => line.includes('"state":"done"')));
	const proposal = entriesOf(inner).find((entry) => entry.type === "proposal");
	const id = String((proposal as { proposal?: string } | undefined)?.proposal ?? "");

	const decide = async (decision: "accept" | "reject") =>
		send(session, { command: "decide_proposal", session: "s1", proposal: id, decision });

	let release: () => void = () => undefined;
	hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const late = decide("reject");
	// The late one has its snapshot; the other decision now lands in full.
	const early = await decide("accept");
	expect(early.ok).toBe(true);
	release();
	const lateOutcome = await late;

	expect(lateOutcome.ok ? "" : lateOutcome.error.code).toBe("conflict");
	expect(entriesOf(inner).filter((entry) => entry.type === "proposal_decided")).toHaveLength(1);
});

test("CMD04 a follow-up that fits the command cap but not the entry is bad_request, and the finished run stays done", async () => {
	const { session, storage } = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	valueOf(await send(session, { command: "start", task: "test-task", input: "go" }));
	await until(() => finished(storage));
	const before = storage.saved().length;

	// Each quote is one byte in the text and two in the saved line, so this is under
	// the command cap and over the entry cap. Writing it would fail the run it
	// continues, so it has to be refused before anything is written.
	const refused = errorOf(
		await send(session, { command: "prompt", session: "s1", text: '"'.repeat(600_000) }),
	);
	expect(refused.code).toBe("bad_request");
	expect(storage.saved()).toHaveLength(before);
	expect(storage.saved().some((line) => line.includes('"state":"failed"'))).toBe(false);
});
