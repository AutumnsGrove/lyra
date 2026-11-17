import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import {
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolReturning,
	toolTakingTime,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import type { RunEvent } from "./events.js";
import { createRun, type RunSetup } from "./run-handle.js";
import { readRecord, until } from "./run-harness.testing.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 3)". */

function controlHarness(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[],
	options: { maxLineBytes?: number } = {},
) {
	const clock = fakeClock();
	const ids = counterIds();
	const storage = memoryStorage(options);
	const model = scriptedModel(turns, { clock });
	const tools = makeTools(clock);
	const setup: RunSetup = {
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools,
		model,
		storage,
		clock,
		ids,
	};
	return {
		clock,
		storage,
		model,
		tools,
		start: (overrides: Partial<RunSetup> = {}) => createRun({ ...setup, ...overrides }),
	};
}

/** The record's shape, with a label on a user message so a steer stands out. */
function shapeOf(entries: { type: string; label?: string }[]): string[] {
	return entries.map((entry) =>
		entry.type === "user_message" ? `user:${entry.label ?? ""}` : entry.type,
	);
}

test("STP01 abort before the first request parks as stopped and writes nothing more", async () => {
	const stalled = controlHarness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
		createFinishTool(),
	]);
	const handle = stalled.start();
	const seen: RunEvent[] = [];
	const unsubscribe = handle.subscribe((event) => seen.push(event));
	unsubscribe();
	handle.abort();

	const result = await handle.outcome;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped", turns: 0 });
	expect(stalled.model.requests).toHaveLength(0);
	// The listener was removed before any event, and the listener path is proven by
	// the other cases here, so this is about the unsubscribe and nothing else.
	expect(seen).toEqual([]);

	const record = await readRecord(stalled.storage);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "stopped",
	});
});

test("STP01 abort during the model call parks as stopped", async () => {
	const waiting = controlHarness(
		[{ toolCalls: [{ id: "c1", name: "finish" }], delayMs: 5_000 }],
		() => [createFinishTool()],
	);
	const handle = waiting.start();
	await until(() => waiting.model.requests.length === 1);
	// The request is in flight, so this is the case it claims to be.
	expect(waiting.model.requests).toHaveLength(1);
	handle.abort();

	const result = await handle.outcome;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped" });
	expect(waiting.clock.pending()).toBe(0);
});

test("STP01 abort during a tool answers every call, and a second abort changes nothing", async () => {
	const tooling = controlHarness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "slow", args: {} },
					{ id: "c2", name: "read", args: {} },
				],
			},
		],
		(clock) => [toolTakingTime("slow", 60_000, clock), toolReturning("read", "content")],
	);
	const events: RunEvent[] = [];
	const handle = tooling.start();
	handle.subscribe((event) => events.push(event));
	await until(() => events.some((event) => event.type === "tool_start"));
	expect(events.some((event) => event.type === "tool_start")).toBe(true);

	handle.abort();
	handle.abort();

	const result = await handle.outcome;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped" });
	expect(tooling.clock.pending()).toBe(0);

	const record = await readRecord(tooling.storage);
	const results = record.entries.filter((entry) => entry.type === "tool_message");
	// Both calls are answered, so the record stays paired: the second never ran.
	expect(results.map((entry) => (entry.type === "tool_message" ? entry.toolCallId : ""))).toEqual(
		["c1", "c2"],
	);
	expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
});

test("STP01 abort between steps parks before the next request", async () => {
	let abort = (): void => {
		throw new Error("the handle was not set up");
	};
	const between = controlHarness(
		[
			{ toolCalls: [{ id: "c1", name: "stop_it", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [
			{
				spec: {
					name: "stop_it",
					description: "stops the run",
					parameters: { type: "object" },
				},
				async execute() {
					abort();
					return { isError: false, content: "stopped it" };
				},
			},
			createFinishTool(),
		],
	);
	const handle = between.start();
	abort = () => handle.abort();

	const result = await handle.outcome;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped" });
	// The next turn was never asked for: one request, not two.
	expect(between.model.requests).toHaveLength(1);
	const record = await readRecord(between.storage);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "stopped",
	});
});

test("STP02 a steer during a tool is saved after its results and read next", async () => {
	const steering = controlHarness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const events: RunEvent[] = [];
	const handle = steering.start();
	handle.subscribe((event) => events.push(event));
	await until(() => events.some((event) => event.type === "tool_start"));
	expect(events.some((event) => event.type === "tool_start")).toBe(true);

	expect(handle.steer("also check the other one")).toMatchObject({ ok: true });
	steering.clock.advance(5_000);

	const result = await handle.outcome;
	expect(result.reason).toBe("done");

	const record = await readRecord(steering.storage);
	// The steer comes after the tool's result, not between the call and it.
	expect(shapeOf(record.entries)).toEqual([
		"user:task",
		"status",
		"assistant_message",
		"tool_message",
		"user:steer",
		"assistant_message",
		"tool_message",
		"status",
	]);
	const steer = record.entries.find(
		(entry) => entry.type === "user_message" && entry.label === "steer",
	);
	const toolResult = record.entries.find((entry) => entry.type === "tool_message");
	expect(steer?.parent).toBe(toolResult?.id);

	// The next request carries it, which is the point of saving it at the gap.
	const second = steering.model.requests[1];
	expect(
		second?.messages.some(
			(message) => message.role === "user" && message.text === "also check the other one",
		),
	).toBe(true);
});

test("STP02 a steer during the model call is read at the gap after that turn", async () => {
	const steering = controlHarness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }], delayMs: 5_000 },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);
	const handle = steering.start();
	await until(() => steering.model.requests.length === 1);
	expect(steering.model.requests).toHaveLength(1);

	expect(handle.steer("try the other approach")).toMatchObject({ ok: true });
	steering.clock.advance(5_000);

	const result = await handle.outcome;
	expect(result.reason).toBe("done");

	const record = await readRecord(steering.storage);
	expect(shapeOf(record.entries)).toEqual([
		"user:task",
		"status",
		"assistant_message",
		"tool_message",
		"user:steer",
		"assistant_message",
		"tool_message",
		"status",
	]);
});

test("STP03 a steer or follow-up after the run ended is a conflict and nothing is saved", async () => {
	const finished = controlHarness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
		createFinishTool(),
	]);
	const handle = finished.start();
	const result = await handle.outcome;
	expect(result.reason).toBe("done");
	const saved = finished.storage.saved().length;

	const steered = handle.steer("too late");
	expect(steered.ok).toBe(false);
	expect(steered.ok ? "" : steered.error.code).toBe("conflict");
	const followed = handle.followUp("too late");
	expect(followed.ok).toBe(false);
	expect(followed.ok ? "" : followed.error.code).toBe("conflict");

	expect(finished.storage.saved()).toHaveLength(saved);
});

test("STP04 follow-ups are read at an accepted finish, in arrival order", async () => {
	const ending = controlHarness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const events: RunEvent[] = [];
	const handle = ending.start();
	handle.subscribe((event) => events.push(event));
	await until(() => events.some((event) => event.type === "tool_start"));
	expect(events.some((event) => event.type === "tool_start")).toBe(true);

	expect(handle.followUp("first follow-up")).toMatchObject({ ok: true });
	expect(handle.followUp("second follow-up")).toMatchObject({ ok: true });
	ending.clock.advance(5_000);

	const result = await handle.outcome;
	// The run continued past the accepted finish, so there was a third turn.
	expect(result).toMatchObject({ reason: "done", turns: 3 });

	const record = await readRecord(ending.storage);
	const followUps = record.entries.filter(
		(entry) => entry.type === "user_message" && entry.label === "follow_up",
	);
	expect(followUps.map((entry) => (entry.type === "user_message" ? entry.text : ""))).toEqual([
		"first follow-up",
		"second follow-up",
	]);
});

test("STP04 a follow-up is read when the model stops without finishing", async () => {
	const silent = controlHarness(
		[{ text: "I think that is everything." }, { toolCalls: [{ id: "c1", name: "finish" }] }],
		() => [createFinishTool()],
	);
	const handle = silent.start();
	// Queued before the first request, so it is waiting when the model falls silent.
	expect(handle.followUp("no, keep going")).toMatchObject({ ok: true });

	const result = await handle.outcome;
	expect(result).toMatchObject({ reason: "done", turns: 2 });

	const record = await readRecord(silent.storage);
	expect(shapeOf(record.entries)).toEqual([
		"user:task",
		"status",
		"assistant_message",
		"user:follow_up",
		"assistant_message",
		"tool_message",
		"status",
	]);
});

test("STP05 a steer or follow-up over the entry cap is refused and nothing is queued", async () => {
	const small = controlHarness(
		[{ toolCalls: [{ id: "c1", name: "finish" }] }],
		() => [createFinishTool()],
		{ maxLineBytes: 400 },
	);
	const handle = small.start();
	const tooBig = "x".repeat(500);

	const steered = handle.steer(tooBig);
	expect(steered.ok).toBe(false);
	expect(steered.ok ? "" : steered.error.code).toBe("bad_request");
	const followed = handle.followUp(tooBig);
	expect(followed.ok).toBe(false);
	expect(followed.ok ? "" : followed.error.code).toBe("bad_request");

	const result = await handle.outcome;
	expect(result.reason).toBe("done");

	// The refusal happened before anything was written, so the record has no steer.
	const record = await readRecord(small.storage);
	expect(
		record.entries.some((entry) => entry.type === "user_message" && entry.label !== "task"),
	).toBe(false);
});
