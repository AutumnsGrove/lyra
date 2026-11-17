import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
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
import { runTask } from "./run.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/core-loop.md`, "The loop (step 1b)". */

function harness(turns: readonly ScriptedTurn[], makeTools: (clock: FakeClock) => Tool[]) {
	const clock = fakeClock();
	const ids = counterIds();
	const storage = memoryStorage();
	const events: RunEvent[] = [];
	const model = scriptedModel(turns, { clock });
	const tools = makeTools(clock);

	const run = async (overrides: Partial<Parameters<typeof runTask>[0]> = {}) =>
		runTask({
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
			onEvent: (event) => {
				events.push(event);
			},
			...overrides,
		});

	return { clock, ids, storage, events, model, tools, run };
}

async function readRecord(storage: { read(): Promise<{ ok: boolean }> }): Promise<LoadedRecord> {
	const read = (await storage.read()) as { ok: true; value: string[] } | { ok: false };
	expect(read.ok).toBe(true);
	if (!read.ok) {
		throw new Error("the storage read failed");
	}
	const loaded = loadRecord(read.value);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		throw new Error(`the record did not load: ${loaded.error.message}`);
	}
	return loaded.value;
}

/** Let a run that is waiting on the clock get as far as it can, moving time each turn. */
async function drive<T>(clock: FakeClock, running: Promise<T>, stepMs = 100): Promise<T> {
	let done = false;
	void running.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let tick = 0; tick < 100 && !done; tick += 1) {
		await Promise.resolve();
		clock.advance(stepMs);
		await Promise.resolve();
	}
	return running;
}

test("LOOP01 tool, tool, finish ends done with a record in order and one run_end", async () => {
	const threeCalls = harness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: { number: 1 } }] },
			{ toolCalls: [{ id: "c2", name: "read", args: { number: 2 } }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		() => [toolReturning("read", "the content"), createFinishTool()],
	);

	const result = await threeCalls.run();
	expect(result.reason).toBe("done");
	expect(result.turns).toBe(3);

	const record = await readRecord(threeCalls.storage);
	expect(record.header.run).toBe("run-1");
	expect(record.header.task).toBe("test-task");
	expect(record.notes).toEqual([]);
	expect(record.entries.map((entry) => entry.type)).toEqual([
		"user_message",
		"status",
		"assistant_message",
		"tool_message",
		"assistant_message",
		"tool_message",
		"assistant_message",
		"tool_message",
		"status",
	]);
	expect(
		record.entries.flatMap((entry) => (entry.type === "status" ? [entry.state] : [])),
	).toEqual(["running", "done"]);

	const types = threeCalls.events.map((event) => event.type);
	expect(types[0]).toBe("run_start");
	expect(types.filter((type) => type === "run_end")).toHaveLength(1);
	expect(types.at(-1)).toBe("run_end");
	expect(threeCalls.events.at(-1)).toMatchObject({ type: "run_end", reason: "done" });
	// The record was complete before the end was announced.
	expect(types.lastIndexOf("message_end")).toBeLessThan(types.indexOf("run_end"));

	// Every `seq` on an event is a position in the record, and the run is constant.
	const seqs = threeCalls.events.flatMap((event) => ("seq" in event ? [event.seq] : []));
	expect(seqs.length).toBeGreaterThan(0);
	expect(new Set(threeCalls.events.map((event) => event.run))).toEqual(new Set(["run-1"]));
	const saved = await threeCalls.storage.read();
	expect(saved.ok && saved.value.length).toBe(1 + record.entries.length);
});

test("LOOP02 calls that take different times are saved and announced in call order", async () => {
	const mixed = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "slow", args: {} },
					{ id: "c2", name: "quick", args: {} },
					{ id: "c3", name: "slow", args: {} },
					{ id: "c4", name: "finish" },
				],
			},
		],
		(clock) => [
			toolTakingTime("slow", 300, clock),
			toolReturning("quick", "done at once"),
			createFinishTool(),
		],
	);

	const result = await drive(mixed.clock, mixed.run());
	expect(result.reason).toBe("done");
	expect(result.turns).toBe(1);

	const record = await readRecord(mixed.storage);
	const results = record.entries.flatMap((entry) =>
		entry.type === "tool_message" ? [entry.toolCallId] : [],
	);
	expect(results).toEqual(["c1", "c2", "c3", "c4"]);

	const ends = mixed.events.flatMap((event) => (event.type === "tool_end" ? [event.callId] : []));
	expect(ends).toEqual(["c1", "c2", "c3", "c4"]);

	// Each call set a deadline timer and cancelled it when the tool answered.
	expect(mixed.clock.pending()).toBe(0);
});

test("LOOP03 usage is reported per reply and summed, and cost only when every reply has one", async () => {
	const withCost = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "read", args: {} }],
				usage: {
					inputTokens: 10,
					outputTokens: 5,
					cost: { amount: 0.1, currency: "USD", source: "provider" },
				},
			},
			{
				toolCalls: [{ id: "c2", name: "finish" }],
				usage: {
					inputTokens: 20,
					outputTokens: 7,
					cost: { amount: 0.2, currency: "USD", source: "provider" },
				},
			},
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	const result = await withCost.run();
	expect(result.usage).toEqual({
		inputTokens: 30,
		outputTokens: 12,
		cost: { amount: 0.1 + 0.2, currency: "USD", source: "provider" },
	});
	const usage = withCost.events.flatMap((event) =>
		event.type === "usage" ? [{ input: event.inputTokens, output: event.outputTokens }] : [],
	);
	expect(usage).toEqual([
		{ input: 10, output: 5 },
		{ input: 20, output: 7 },
	]);

	// One reply without a cost makes the total unknown, so no cost is reported.
	const partial = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "read", args: {} }],
				usage: { inputTokens: 1, outputTokens: 1 },
			},
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);
	const partialResult = await partial.run();
	expect(partialResult.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
	expect(partialResult.usage).not.toHaveProperty("cost");
});

test("LOOP13 the same script, ids and clock write the same record twice", async () => {
	const script: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "read", args: { number: 1 } }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];

	const makeTools = (): Tool[] => [toolReturning("read", "the content"), createFinishTool()];
	const first = harness(script, makeTools);
	const second = harness(script, makeTools);
	expect((await first.run()).reason).toBe("done");
	expect((await second.run()).reason).toBe("done");

	// Byte for byte: the clock, the ids and the script are the only inputs that
	// vary, and all three are the same.
	expect(second.storage.saved()).toEqual(first.storage.saved());
	expect(second.events).toEqual(first.events);
	expect(first.storage.saved().length).toBeGreaterThan(1);
});
