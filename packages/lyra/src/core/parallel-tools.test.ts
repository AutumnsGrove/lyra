import fc from "fast-check";
import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import type { RecordEntry } from "../record/entries.js";
import { loadRecord } from "../record/load.js";
import {
	createFinishTool,
	executionCounter,
	fakeClock,
	scriptedModel,
	toolAsking,
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { drive, readRecord, runHarness as harness, until } from "./run-harness.testing.js";
import { runTask, type RunConfig } from "./run.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/core-loop.md`, "Parallel tool calls (decision 154)". */

/** A tool that takes its time and remembers when it started, for the cap's rows. */
function timedTool(name: string, ms: number, clock: FakeClock, starts: number[]): Tool {
	const made = toolTakingTime(name, ms, clock, { parallel: true });
	return {
		...made,
		execute: (args, ctx) => {
			starts.push(clock.now());
			return made.execute(args, ctx);
		},
	};
}

/** The call ids of the record's tool results, in the order they were saved. */
async function savedCalls(storage: ReturnType<typeof memoryStorage>): Promise<string[]> {
	const record = await readRecord(storage);
	return record.entries.flatMap((entry) =>
		entry.type === "tool_message" ? [entry.toolCallId] : [],
	);
}

async function toolResults(
	storage: ReturnType<typeof memoryStorage>,
): Promise<{ id: string; isError: boolean; content: string }[]> {
	const record = await readRecord(storage);
	return record.entries.flatMap((entry) =>
		entry.type === "tool_message"
			? [{ id: entry.toolCallId, isError: entry.isError, content: entry.content }]
			: [],
	);
}

function startEvents(events: readonly { type: string; ts?: number; callId?: string }[]) {
	return events.flatMap((event) =>
		event.type === "tool_start" ? [{ id: event.callId ?? "", at: event.ts ?? 0 }] : [],
	);
}

test("LOOP17 a group of calls is saved and announced in call order whatever order it finished in", async () => {
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "slow", args: { n: 1 } },
					{ id: "c2", name: "quick", args: { n: 2 } },
					{ id: "c3", name: "medium", args: { n: 3 } },
				],
			},
			{ toolCalls: [{ id: "c4", name: "finish" }] },
		],
		(clock) => [
			// The first call is the slowest, so the calls really do finish out of order.
			toolTakingTime("slow", 300, clock, { parallel: true }),
			toolReturning("quick", "at once", { parallel: true }),
			toolTakingTime("medium", 200, clock, { parallel: true }),
			createFinishTool(),
		],
	);

	const result = await drive(group.clock, group.run());
	expect(result.reason).toBe("done");

	expect(await savedCalls(group.storage)).toEqual(["c1", "c2", "c3", "c4"]);
	const ends = group.events.flatMap((event) => (event.type === "tool_end" ? [event.callId] : []));
	expect(ends).toEqual(["c1", "c2", "c3", "c4"]);

	// They ran together: all three were announced at the same clock time, and every
	// start came before the first result, which a serialized batch could not do.
	const starts = startEvents(group.events).slice(0, 3);
	expect(starts.map((start) => start.id)).toEqual(["c1", "c2", "c3"]);
	expect(new Set(starts.map((start) => start.at)).size).toBe(1);
	const types = group.events.map((event) => event.type);
	const beforeFirstResult = types.slice(0, types.indexOf("tool_end"));
	expect(beforeFirstResult.filter((type) => type === "tool_start")).toHaveLength(3);

	expect(group.clock.pending()).toBe(0);
});

test("LOOP18 one call in a group fails and the others still answer, each in its own place", async () => {
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "slow", args: {} },
					{ id: "c2", name: "refuse", args: {} },
					{ id: "c3", name: "explode", args: {} },
					{ id: "c4", name: "quick", args: {} },
				],
			},
			{ toolCalls: [{ id: "c5", name: "finish" }] },
		],
		(clock) => [
			toolTakingTime("slow", 200, clock, { parallel: true }),
			toolReturningError("refuse", "the provider said no", { parallel: true }),
			toolThatThrows("explode", "it broke", { parallel: true }),
			toolReturning("quick", "fine", { parallel: true }),
			createFinishTool(),
		],
	);

	const result = await drive(group.clock, group.run());
	expect(result.reason).toBe("done");

	// The four really were in flight together, so the failure is the group's.
	expect(
		new Set(
			startEvents(group.events)
				.slice(0, 4)
				.map((start) => start.at),
		).size,
	).toBe(1);

	const results = await toolResults(group.storage);
	expect(results.map((entry) => entry.id)).toEqual(["c1", "c2", "c3", "c4", "c5"]);
	expect(results.slice(0, 5).map((entry) => entry.isError)).toEqual([
		false,
		true,
		true,
		false,
		false,
	]);
	// A failure is a result the model reads, never a hole in the record.
	expect(results[1]?.content).toBe("the provider said no");
	expect(results[2]?.content).toContain("it broke");
	expect(group.clock.pending()).toBe(0);
});

test("LOOP19 a stop during a group answers every call and leaves no timer waiting", async () => {
	const controller = new AbortController();
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "look", args: {} },
					{ id: "c3", name: "scan", args: {} },
				],
			},
		],
		(clock) => [
			toolTakingTime("read", 30_000, clock, { parallel: true }),
			toolTakingTime("look", 60_000, clock, { parallel: true }),
			toolTakingTime("scan", 90_000, clock, { parallel: true }),
		],
	);

	const running = group.run({ signal: controller.signal });
	await until(() => startEvents(group.events).length === 3);
	// All three really were in flight, which is the case this test is about.
	expect(startEvents(group.events)).toHaveLength(3);
	controller.abort();

	const result = await running;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped" });

	const results = await toolResults(group.storage);
	expect(results.map((entry) => entry.id)).toEqual(["c1", "c2", "c3"]);
	expect(results.every((entry) => entry.isError)).toBe(true);

	// The deadline timers of the calls the stop cut short are gone with them.
	expect(group.clock.pending()).toBe(0);
});

test("LOOP20 a deadline in a group is one call's error, not the whole group's", async () => {
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "quick", args: {} },
					{ id: "c2", name: "slow", args: {} },
					{ id: "c3", name: "medium", args: {} },
				],
			},
			{ toolCalls: [{ id: "c4", name: "finish" }] },
		],
		(clock) => [
			toolReturning("quick", "at once", { parallel: true }),
			toolTakingTime("slow", 60_000, clock, { parallel: true }),
			toolTakingTime("medium", 300, clock, { parallel: true }),
			createFinishTool(),
		],
	);

	const result = await drive(group.clock, group.run({ toolDeadlineMs: 1_000 }));
	expect(result.reason).toBe("done");

	expect(
		new Set(
			startEvents(group.events)
				.slice(0, 3)
				.map((start) => start.at),
		).size,
	).toBe(1);

	const results = await toolResults(group.storage);
	expect(results.map((entry) => entry.id)).toEqual(["c1", "c2", "c3", "c4"]);
	expect(results.map((entry) => entry.isError)).toEqual([false, true, false, false]);
	expect(results[1]?.content).toContain("deadline");
	expect(results[2]?.content).toContain("300ms");
	expect(group.clock.pending()).toBe(0);
});

test("LOOP21 a group that raises a question saves the calls around it and parks once", async () => {
	const executions = executionCounter();
	const asking = toolAsking(
		"ask",
		{ kind: "question", title: "Which one?", message: "Pick a shelf." },
		{ parallel: true, executions },
	);
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "ask", args: {} },
					{ id: "c3", name: "later", args: {} },
				],
			},
		],
		() => [
			toolReturning("read", "the shelf", { parallel: true, executions }),
			asking,
			toolReturning("later", "the later one", { parallel: true, executions }),
		],
	);

	const parked = await group.run({ canAsk: true });
	expect(parked).toMatchObject({ reason: "parked", parkedReason: "waiting_for_person" });

	// The calls on either side of the question really ran, so their results are
	// saved rather than thrown away: the ask is a place in the record, not a cut.
	expect(executions.count("c1")).toBe(1);
	expect(executions.count("c3")).toBe(1);
	expect(await savedCalls(group.storage)).toEqual(["c1", "c3"]);
	const record = await readRecord(group.storage);
	const order = record.entries.flatMap((entry) => {
		if (entry.type === "request") {
			return [`request:${entry.callId ?? ""}`];
		}
		return entry.type === "tool_message" ? [entry.toolCallId] : [];
	});
	expect(order).toEqual(["c1", "request:c2", "c3"]);
	expect(record.entries.find((entry) => entry.type === "request")).toMatchObject({
		type: "request",
		kind: "question",
		callId: "c2",
	});
	expect(group.clock.pending()).toBe(0);
});

test("LOOP21 the answer resumes the group: the question's result is the person's words", async () => {
	const executions = executionCounter();
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{ id: "c1", name: "read", args: {} },
				{ id: "c2", name: "ask", args: {} },
				{ id: "c3", name: "later", args: {} },
			],
		},
		{ toolCalls: [{ id: "c4", name: "finish" }] },
	];
	const clock = fakeClock();
	const storage = memoryStorage();
	const setup: Omit<RunConfig, "storage" | "model" | "resume" | "onEvent"> = {
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [
			toolReturning("read", "the shelf", { parallel: true, executions }),
			toolAsking(
				"ask",
				{ kind: "question", title: "Which one?", message: "Pick a shelf." },
				{ parallel: true, executions },
			),
			toolReturning("later", "the later one", { parallel: true, executions }),
			createFinishTool(),
		],
		clock,
		ids: counterIds(),
	};

	const parked = await runTask({
		...setup,
		model: scriptedModel(turns, { clock }),
		storage,
		canAsk: true,
	});
	expect(parked.reason).toBe("parked");

	const record = await readRecord(storage);
	const request = record.entries.find((entry) => entry.type === "request");
	if (request?.type !== "request") {
		throw new Error("no request was saved");
	}
	const last = storage.saved().at(-1);
	const answered = await storage.append(
		JSON.stringify({
			type: "request_answered",
			id: "e_answer_1",
			parent: JSON.parse(last ?? "{}").id ?? null,
			ts: 100,
			request: request.request,
			decision: "approve",
			text: "the one on the shelf",
		}),
	);
	expect(answered.ok).toBe(true);

	const resumed = await runTask({
		...setup,
		model: scriptedModel(turns, { clock }),
		storage,
		canAsk: true,
		resume: { lines: storage.saved(), by: "person" },
	});
	expect(resumed.reason).toBe("done");

	// The answer is the question's result, and the call beside it was saved once.
	const results = await toolResults(storage);
	expect(results.map((entry) => entry.id)).toEqual(["c1", "c3", "c2", "c4"]);
	expect(results[2]?.content).toBe("the one on the shelf");
	expect(executions.count("c2")).toBe(1);
	expect(executions.count("c3")).toBe(1);
});

test("LOOP22 a tool with an apply is a barrier even when it opts in", async () => {
	const applied: string[] = [];
	// Built by hand rather than by `defineTool`, which refuses this combination: the
	// scheduler must refuse it too, because a group reads one state.
	const writing: Tool = {
		...toolReturning("write", "wrote a line"),
		parallel: true,
		apply: (state: unknown, _args: unknown) => {
			applied.push("write");
			return state;
		},
	};
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "slow", args: {} },
					{ id: "c2", name: "write", args: {} },
					{ id: "c3", name: "quick", args: {} },
				],
			},
			{ toolCalls: [{ id: "c4", name: "finish" }] },
		],
		(clock) => [
			toolTakingTime("slow", 200, clock, { parallel: true }),
			writing,
			toolReturning("quick", "at once", { parallel: true }),
			createFinishTool(),
		],
	);

	const result = await drive(group.clock, group.run());
	expect(result.reason).toBe("done");
	expect(applied).toEqual(["write"]);

	// Each call waited for the one before it: three separate moments, not one.
	const starts = startEvents(group.events)
		.slice(0, 3)
		.map((start) => start.at);
	const origin = starts[0] ?? 0;
	expect(starts.map((at) => at - origin)).toEqual([0, 200, 200]);
	expect(await savedCalls(group.storage)).toEqual(["c1", "c2", "c3", "c4"]);
	expect(group.clock.pending()).toBe(0);
});

test("LOOP22 a tool whose policy asks is a barrier even when it opts in", async () => {
	const executions = executionCounter();
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "write", args: {} },
					{ id: "c3", name: "look", args: {} },
				],
			},
		],
		() => [
			toolReturning("read", "the page", { parallel: true, executions }),
			toolReturning("write", "wrote a line", { parallel: true, policy: "ask", executions }),
			toolReturning("look", "the other page", { parallel: true, executions }),
		],
	);

	const result = await group.run({ canAsk: true });
	expect(result).toMatchObject({ reason: "parked", parkedReason: "waiting_for_person" });

	// The ask stopped the batch where it was: nothing behind it ran while a person
	// was deciding.
	expect(await savedCalls(group.storage)).toEqual(["c1"]);
	expect(executions.count("c2")).toBe(0);
	expect(executions.count("c3")).toBe(0);
});

test("LOOP23 a group larger than the cap starts the next chunk when the last one answered", async () => {
	const starts: number[] = [];
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "read", args: {} },
					{ id: "c3", name: "read", args: {} },
					{ id: "c4", name: "read", args: {} },
					{ id: "c5", name: "read", args: {} },
				],
			},
			{ toolCalls: [{ id: "c6", name: "finish" }] },
		],
		(clock) => [timedTool("read", 100, clock, starts), createFinishTool()],
	);

	const result = await drive(group.clock, group.run({ maxParallelCalls: 2 }));
	expect(result.reason).toBe("done");
	const origin = starts[0] ?? 0;
	expect(starts.map((at) => at - origin)).toEqual([0, 0, 100, 100, 200]);
	expect(await savedCalls(group.storage)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6"]);
	expect(group.clock.pending()).toBe(0);
});

test("LOOP23 a cap that is not a positive whole number falls back to the default", async () => {
	const starts: number[] = [];
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "read", args: {} },
					{ id: "c3", name: "read", args: {} },
				],
			},
			{ toolCalls: [{ id: "c4", name: "finish" }] },
		],
		(clock) => [timedTool("read", 100, clock, starts), createFinishTool()],
	);

	// A nonsense cap is not a cap, so the default applies and the three run together.
	const result = await drive(group.clock, group.run({ maxParallelCalls: 0 }));
	expect(result.reason).toBe("done");
	const origin = starts[0] ?? 0;
	expect(starts.map((at) => at - origin)).toEqual([0, 0, 0]);
	expect(await savedCalls(group.storage)).toEqual(["c1", "c2", "c3", "c4"]);
});

/**
 * A script of groups, so the property compares the same calls run two ways. The
 * tool names carry different durations, so a group's calls finish out of order.
 */
const groupedScript: fc.Arbitrary<ScriptedTurn[]> = fc
	.array(fc.array(fc.constantFrom("slow", "quick", "medium"), { minLength: 1, maxLength: 3 }), {
		minLength: 1,
		maxLength: 2,
	})
	.map((turns) => [
		...turns.map((names, turn) => ({
			toolCalls: names.map((name, index) => ({
				id: `c${turn}${index}`,
				name,
				args: {},
			})),
		})),
		{ toolCalls: [{ id: "cf", name: "finish" }] },
	]);

/** Whether any two calls were in flight at once, read from the stream of events. */
function overlapped(events: readonly { type: string }[]): boolean {
	let open = 0;
	for (const event of events) {
		if (event.type === "tool_start") {
			open += 1;
			if (open > 1) {
				return true;
			}
		}
		if (event.type === "tool_end") {
			open -= 1;
		}
	}
	return false;
}

/** The record's entries with only the clock's timestamps removed. */
function withoutTime(entries: readonly RecordEntry[]): unknown[] {
	return entries.map((entry) => ({ ...entry, ts: 0 }));
}

test("LOOP24 property: a run of groups saves the record the same calls sequentially save", async () => {
	await fc.assert(
		fc.asyncProperty(groupedScript, async (turns) => {
			const run = async (parallel: boolean) => {
				const group = harness(turns, (clock) => [
					toolTakingTime("slow", 300, clock, { parallel }),
					toolReturning("quick", "quick answered", { parallel }),
					toolTakingTime("medium", 200, clock, { parallel }),
					createFinishTool(),
				]);
				const result = await drive(group.clock, group.run({ maxParallelCalls: 3 }));
				expect(result.reason).toBe("done");
				const record = await readRecord(group.storage);
				return {
					entries: withoutTime(record.entries),
					overlapped: overlapped(group.events),
				};
			};

			// The positive case first: the script really did more than one call, so the
			// comparison below is not two empty records agreeing.
			expect(turns.length).toBeGreaterThan(1);
			const together = await run(true);
			const oneByOne = await run(false);
			// The positive case: a reply that asked for more than one call really did run
			// them together, and the same script one at a time never overlapped, so the
			// comparison below is between two different schedules.
			const hasGroup = turns.some((turn) => (turn.toolCalls ?? []).length > 1);
			expect(together.overlapped).toBe(hasGroup);
			expect(oneByOne.overlapped).toBe(false);
			expect(together.entries).toEqual(oneByOne.entries);
		}),
	);
});
