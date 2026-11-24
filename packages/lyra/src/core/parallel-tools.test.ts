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
import { createRuntime } from "./runtime.js";
import { runTask, type RunConfig } from "./run.js";
import { defineTool, type Tool } from "./tool.js";

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
	// All three really were in flight together, which a serial batch could not show.
	expect(new Set(startEvents(group.events).map((start) => start.at)).size).toBe(1);
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

test("LOOP21 a second question in one chunk is answered rather than overwriting the first", async () => {
	const ask = (name: string, title: string) =>
		toolAsking(
			name,
			{ kind: "question", title, message: `${title} please.` },
			{ parallel: true },
		);
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "read", args: {} },
					{ id: "c2", name: "ask1", args: {} },
					{ id: "c3", name: "ask2", args: {} },
				],
			},
		],
		() => [
			toolReturning("read", "the page", { parallel: true }),
			ask("ask1", "First?"),
			ask("ask2", "Second?"),
		],
	);

	const result = await group.run({ canAsk: true });
	expect(result).toMatchObject({ reason: "parked", parkedReason: "waiting_for_person" });

	const record = await readRecord(group.storage);
	const order = record.entries.flatMap((entry) => {
		if (entry.type === "request") {
			return [`request:${entry.callId ?? ""}`];
		}
		return entry.type === "tool_message" ? [entry.toolCallId] : [];
	});
	// One question is on the record, and the call that could not be asked is answered
	// in its own place rather than left dangling or overwriting the first request.
	expect(order).toEqual(["c1", "request:c2", "c3"]);
	expect(record.entries.filter((entry) => entry.type === "request")).toHaveLength(1);
	const answered = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "c3",
	);
	expect(answered?.type === "tool_message" ? answered.isError : false).toBe(true);
	expect(answered?.type === "tool_message" ? answered.content : "").toContain(
		"already waiting for a person",
	);
});

test("LOOP21 a done result behind a question still ends the run after the answer", async () => {
	// `[ask, finish]` in one chunk: the request is saved first, the done result lands
	// behind it, and the resume has to answer the question before concluding the reply
	// is finished (found in review: the answer was dropped).
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{ id: "c1", name: "ask", args: {} },
				{ id: "c2", name: "finish", args: {} },
			],
		},
	];
	const clock = fakeClock();
	const storage = memoryStorage();
	const tools: Tool[] = [
		toolAsking(
			"ask",
			{ kind: "question", title: "Which one?", message: "Pick a shelf." },
			{ parallel: true },
		),
		{ ...createFinishTool(), parallel: true, safeToRepeat: true },
	];
	const setup: Omit<RunConfig, "storage" | "model" | "resume" | "onEvent"> = {
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools,
		clock,
		ids: counterIds(),
	};

	const parked = await runTask({
		...setup,
		model: scriptedModel(turns, { clock }),
		storage,
		canAsk: true,
	});
	expect(parked).toMatchObject({ reason: "parked", parkedReason: "waiting_for_person" });

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
			text: "the shelf on the left",
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
	// The answer is the question's result, and the done result the group saved behind
	// it ended the run without asking the model for a turn it cannot act on.
	expect(resumed.turns).toBe(1);
	const results = await toolResults(storage);
	// The request came first, the done result was saved behind it, and the answer
	// arrives last, which is the order the record already had.
	expect(results.map((entry) => entry.id)).toEqual(["c2", "c1"]);
	expect(results[1]?.content).toBe("the shelf on the left");
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

test("LOOP25 a call that ends the run mid-group answers the rest the way a serial run does", async () => {
	// A host's own tool may say both "done" and "parallel", and `defineTool` allows
	// that: only an `apply` is refused. The calls behind it were started before its
	// result was saved, and they must not turn into results the finished run keeps.
	const finishing: Tool = { ...createFinishTool(), parallel: true, safeToRepeat: true };
	const group = harness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "finish", args: {} },
					{ id: "c2", name: "read", args: {} },
					{ id: "c3", name: "ask", args: {} },
				],
			},
		],
		() => [
			finishing,
			toolReturning("read", "the page", { parallel: true }),
			toolAsking(
				"ask",
				{ kind: "question", title: "Which one?", message: "Pick a shelf." },
				{ parallel: true },
			),
		],
	);

	const result = await group.run({ canAsk: true });
	expect(result.reason).toBe("done");

	const results = await toolResults(group.storage);
	expect(results.map((entry) => entry.id)).toEqual(["c1", "c2", "c3"]);
	expect(results[0]?.isError).toBe(false);
	expect(results.slice(1).map((entry) => entry.isError)).toEqual([true, true]);
	expect(results.slice(1).map((entry) => entry.content)).toEqual([
		"the run already finished, so this call was not run",
		"the run already finished, so this call was not run",
	]);
	// A question the finished run should never have asked was not asked.
	const record = await readRecord(group.storage);
	expect(record.entries.some((entry) => entry.type === "request")).toBe(false);
});

test("LOOP25 a call whose arguments are refused behind a done answers as a serial run does", async () => {
	// The answer for a call that never runs is decided before the chunk starts, and the
	// `done` beside it is saved first, so this is the case where the chunk's own guard
	// has to come before the pre-decided answers rather than after them (found in
	// review: the record depended on the cap).
	const strict = defineTool({
		name: "strict",
		description: "needs a name",
		parameters: {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		},
		parallel: true,
		async execute() {
			return { isError: false, content: "the name" };
		},
	});
	const run = async (maxParallelCalls: number) => {
		const group = harness(
			[
				{
					toolCalls: [
						{ id: "c1", name: "finish", args: {} },
						{ id: "c2", name: "strict", args: {} },
					],
				},
			],
			() => [{ ...createFinishTool(), parallel: true, safeToRepeat: true }, strict],
		);
		const result = await group.run({ maxParallelCalls });
		expect(result.reason).toBe("done");
		return toolResults(group.storage);
	};

	const together = await run(4);
	expect(together.map((entry) => entry.content)).toEqual([
		"finished",
		"the run already finished, so this call was not run",
	]);
	// The serial chunk size is the reference, and the record must not depend on the cap.
	expect(await run(1)).toEqual(together);
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

test("LOOP23 a recipe's cap reaches a run the runtime starts, not only one it resumes", async () => {
	const clock = fakeClock();
	const starts: number[] = [];
	const runtime = createRuntime({
		storage: memoryStorage(),
		clock,
		ids: counterIds(),
		model: scriptedModel(
			[
				{
					toolCalls: [
						{ id: "c1", name: "read", args: {} },
						{ id: "c2", name: "read", args: {} },
					],
				},
				{ toolCalls: [{ id: "c3", name: "finish" }] },
			],
			{ clock },
		),
		host: "test-host",
	});

	const started = runtime.start({
		runId: "run-1",
		task: "test-task",
		input: "go",
		definition: {
			name: "capped",
			version: 1,
			instructions: "read two pages",
			tools: [timedTool("read", 100, clock, starts), createFinishTool()],
			// A cap of one is a serial run, and the recipe says so where it is written.
			maxParallelCalls: 1,
		},
	});
	if (!started.ok) {
		throw new Error(started.error.message);
	}

	const result = await drive(clock, started.value.outcome);
	expect(result.reason).toBe("done");
	const origin = starts[0] ?? 0;
	expect(starts.map((at) => at - origin)).toEqual([0, 100]);
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
 * tool names carry different durations, so a group's calls finish out of order, and
 * `done` ends the run inside a group, which is the case the calls behind it have to
 * survive (LOOP25).
 */
const groupedScript: fc.Arbitrary<ScriptedTurn[]> = fc
	.array(
		fc.array(fc.constantFrom("slow", "quick", "medium", "done"), {
			minLength: 2,
			maxLength: 5,
		}),
		{ minLength: 1, maxLength: 2 },
	)
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

/**
 * A host's own tool that ends the run, which `defineTool` allows to say `parallel`
 * too: only an `apply` is refused. The calls behind it must still meet the answer a
 * serial run gives them.
 */
function doneTool(parallel: boolean): Tool {
	return {
		spec: {
			name: "done",
			description: "End the run from inside a group.",
			parameters: { type: "object", properties: {} },
		},
		parallel,
		safeToRepeat: true,
		execute: async () => ({
			isError: false,
			content: "finished by the tool",
			done: true,
		}),
	};
}

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
					doneTool(parallel),
					createFinishTool(),
				]);
				// A cap of two, with replies of up to five calls, so the chunk boundaries
				// inside one group are exercised rather than only a group of exactly three.
				const result = await drive(group.clock, group.run({ maxParallelCalls: 2 }));
				const record = await readRecord(group.storage);
				// The ending is compared rather than assumed: a script where a `done` tool
				// is followed by three calls of one name parks as stuck, because the three
				// "already finished" answers count as the same failure three times. That is
				// the loop's safeguard doing its job, and both runs must do it the same way.
				return {
					entries: withoutTime(record.entries),
					reason: result.reason,
					parked: result.parkedDetail ?? null,
					overlapped: overlapped(group.events),
				};
			};

			const together = await run(true);
			const oneByOne = await run(false);
			// The positive case: every reply in this script carries at least two calls, so
			// the group really did overlap and the same script one at a time never could.
			// Without that, the comparison below could be two serial runs agreeing.
			expect(together.overlapped).toBe(true);
			expect(oneByOne.overlapped).toBe(false);
			expect({ reason: together.reason, parked: together.parked }).toEqual({
				reason: oneByOne.reason,
				parked: oneByOne.parked,
			});
			expect(together.entries).toEqual(oneByOne.entries);
		}),
	);
});
