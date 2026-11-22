import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import {
	crashingStorage,
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolReturning,
	type ScriptedTurn,
} from "../testkit/index.js";
import { until } from "./run-harness.testing.js";
import type { CompactionSettings } from "./compaction.js";
import type { Usage } from "./model.js";
import type { RunEvent } from "./events.js";
import type { Limits } from "./limits.js";
import { runTask, type RunConfig, type RunResult } from "./run.js";

/** The rows are in `docs/context-size.md`, "The rows compaction is built against". */

/**
 * The scripted models here are in `"sequence"` mode: a compaction folds older
 * turns into one summary, so the number of assistant messages in a request stops
 * counting the turns that were taken (KIT03's rule is about a kill, not a cut).
 */

interface HarnessOptions {
	/** The window the model slot reports. Absent means the slot does not know one. */
	window?: number | undefined;
	summaries?: readonly ScriptedTurn[];
	compaction?: CompactionSettings;
	limits?: Limits;
	input?: string;
	read?: string;
	look?: string;
	/** Where a resumed run's script picks up. */
	startTurn?: number;
}

interface Harness {
	clock: ReturnType<typeof fakeClock>;
	storage: ReturnType<typeof memoryStorage>;
	model: ReturnType<typeof scriptedModel>;
	events: RunEvent[];
	run(overrides?: Partial<RunConfig>): Promise<RunResult>;
}

function usage(inputTokens: number, outputTokens = 0): Usage {
	return { inputTokens, outputTokens };
}

function harness(turns: readonly ScriptedTurn[], options: HarnessOptions = {}): Harness {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, {
		clock,
		position: "sequence",
		...(options.summaries === undefined ? {} : { summaries: options.summaries }),
		...(options.startTurn === undefined ? {} : { startTurn: options.startTurn }),
	});
	if (options.window !== undefined) {
		model.contextWindow = options.window;
	}
	const tools = [
		toolReturning("read", options.read ?? "x".repeat(400)),
		toolReturning("look", options.look ?? "y".repeat(400)),
		createFinishTool(),
	];
	const events: RunEvent[] = [];
	const run = (overrides: Partial<RunConfig> = {}): Promise<RunResult> =>
		runTask({
			runId: "run-1",
			task: "test-task",
			host: "test-host",
			input: options.input ?? "do the thing",
			system: "you are a test",
			tools,
			model,
			storage,
			clock,
			ids: counterIds(),
			onEvent: (event) => {
				events.push(event);
			},
			compaction: { reserveTokens: 100, keepTokens: 100, ...options.compaction },
			...(options.limits === undefined ? {} : { limits: options.limits }),
			...overrides,
		});
	return { clock, storage, model, events, run };
}

/** A tool call to `name`, with the reported usage a provider would have given. */
function call(id: string, name: string, inputTokens: number): ScriptedTurn {
	return { toolCalls: [{ id, name, args: {} }], usage: usage(inputTokens) };
}

function compactionRequests(model: Harness["model"]) {
	return model.requests.filter((request) => request.purpose === "compaction");
}

function runRequests(model: Harness["model"]) {
	return model.requests.filter((request) => request.purpose === undefined);
}

async function entriesOf(storage: Harness["storage"]) {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : [];
}

test("CMP10 the trigger fires over the threshold and not below it", async () => {
	// Each turn reports the conversation's real growth, so the estimate passes
	// 500 before the fourth request: the third reply said 400, and the step since
	// it is about 100 tokens.
	const turns: ScriptedTurn[] = [
		call("c1", "read", 200),
		call("c2", "read", 300),
		call("c3", "read", 400),
		call("c4", "look", 150),
		call("c5", "finish", 200),
	];

	const above = harness(turns, { window: 600, summaries: [{ text: "the summary so far" }] });
	const result = await above.run();
	expect(result.reason).toBe("done");

	const requests = runRequests(above.model);
	expect(requests).toHaveLength(5);
	expect(compactionRequests(above.model)).toHaveLength(1);
	// The fourth request is the first to see the summary, and it keeps the most
	// recent step verbatim and nothing older.
	expect(requests[3]?.messages[0]).toEqual({
		role: "user",
		text: expect.stringContaining("the summary so far"),
	});
	expect(requests[3]?.messages.map((message) => message.role)).toEqual([
		"user",
		"assistant",
		"tool",
	]);

	const entries = await entriesOf(above.storage);
	const compactions = entries.filter((entry) => entry.type === "compaction");
	expect(compactions).toHaveLength(1);
	expect(compactions[0]).toMatchObject({ trigger: "auto", replaces: 5 });
	const assistants = entries.filter((entry) => entry.type === "assistant_message");
	expect(compactions[0]?.type === "compaction" ? compactions[0].firstKept : "").toBe(
		assistants[2]?.id,
	);
	// The event carries the entry's position, so a reconnecting client sees it too.
	const event = above.events.find((each) => each.type === "compaction");
	expect(event).toMatchObject({ type: "compaction", replaces: 5, trigger: "auto" });
	expect(event !== undefined && "seq" in event ? typeof event.seq : "").toBe("number");

	// The same estimate, a threshold it does not pass: no compaction at all.
	const below = harness(turns, { window: 650 });
	expect((await below.run()).reason).toBe("done");
	expect(compactionRequests(below.model)).toHaveLength(0);
	expect(
		(await entriesOf(below.storage)).filter((entry) => entry.type === "compaction"),
	).toHaveLength(0);
});

test("CMP11 with no known window the run never compacts on its own", async () => {
	// No window on the slot and none in the recipe, and no summary script: a run
	// that tried to compact would fail loudly rather than pass by accident.
	const turns: ScriptedTurn[] = [
		call("c1", "read", 5_000),
		call("c2", "read", 5_000),
		call("c3", "look", 5_000),
		call("c4", "finish", 5_000),
	];
	const unknown = harness(turns);
	const result = await unknown.run();
	expect(result.reason).toBe("done");
	expect(compactionRequests(unknown.model)).toHaveLength(0);
	expect(
		(await entriesOf(unknown.storage)).filter((entry) => entry.type === "compaction"),
	).toHaveLength(0);

	// A slot that reports a window is a different matter: the same script compacts.
	const known = harness(
		[
			call("c1", "read", 200),
			call("c2", "read", 300),
			call("c3", "read", 400),
			call("c4", "look", 150),
			call("c5", "finish", 200),
		],
		{ window: 600, summaries: [{ text: "the summary" }] },
	);
	expect((await known.run()).reason).toBe("done");
	expect(compactionRequests(known.model)).toHaveLength(1);
});

test("CMP12 a summary call that fails parks the run, and a person's resume tries again", async () => {
	// Reported input grows as the conversation does, so the trigger lands before the
	// fifth turn and does not fire again once the summary has made room.
	const turns: ScriptedTurn[] = [
		call("c1", "read", 200),
		call("c2", "look", 300),
		call("c3", "read", 400),
		call("c4", "look", 150),
		call("c5", "finish", 200),
	];
	const failing = harness(turns, {
		window: 600,
		summaries: [{ failures: [{ code: "provider_error", retryable: false }] }],
	});
	const parked = await failing.run();
	expect(parked.reason).toBe("parked");
	expect(parked.parkedReason).toBe("model_unavailable");
	expect(parked.parkedDetail).toBe("compaction_failed");
	// Nothing was written that a summary would have stood for.
	expect(
		(await entriesOf(failing.storage)).filter((entry) => entry.type === "compaction"),
	).toHaveLength(0);

	const read = await failing.storage.read();
	expect(read.ok).toBe(true);
	const restarted = scriptedModel(turns, {
		clock: failing.clock,
		position: "sequence",
		startTurn: 3,
		summaries: [{ text: "the summary at the second try" }],
	});
	restarted.contextWindow = 600;
	const resumed = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [
			toolReturning("read", "x".repeat(400)),
			toolReturning("look", "y".repeat(400)),
			createFinishTool(),
		],
		model: restarted,
		storage: failing.storage,
		clock: failing.clock,
		ids: counterIds(),
		compaction: { reserveTokens: 100, keepTokens: 100 },
		resume: { lines: read.ok ? read.value : [], by: "person" },
	});
	expect(resumed.reason).toBe("done");
	expect(
		(await entriesOf(failing.storage)).filter((entry) => entry.type === "compaction"),
	).toHaveLength(1);
});

test("CMP13 an empty summary is a failure, not a summary", async () => {
	const turns: ScriptedTurn[] = [
		call("c1", "read", 200),
		call("c2", "look", 300),
		call("c3", "read", 400),
		call("c4", "look", 150),
		call("c5", "finish", 200),
	];
	const blank = harness(turns, {
		window: 600,
		summaries: [{ text: "  \n\t " }],
	});
	const result = await blank.run();
	expect(result.reason).toBe("parked");
	expect(result.parkedReason).toBe("model_unavailable");
	expect(result.parkedDetail).toBe("compaction_failed");
	expect(
		(await entriesOf(blank.storage)).filter((entry) => entry.type === "compaction"),
	).toHaveLength(0);
});

test("CMP14 the summary's usage counts toward the run, and toward its token limit", async () => {
	const turns: ScriptedTurn[] = [
		call("c1", "read", 200),
		call("c2", "look", 300),
		call("c3", "read", 400),
		call("c4", "look", 150),
		call("c5", "read", 200),
		call("c6", "read", 250),
		call("c7", "read", 300),
		call("c8", "finish", 350),
	];
	const withSummary = harness(turns, {
		window: 600,
		summaries: [{ text: "the summary", usage: usage(300, 50) }],
		limits: { tokens: 2_000 },
	});
	const compacting = await withSummary.run();
	// The run's own replies come to 1800 before the eighth request. With the
	// summary's 350 on top that is over the limit, so the run parks one turn early.
	expect(compacting.reason).toBe("parked");
	expect(compacting.parkedDetail).toBe("tokens");
	expect(compacting.turns).toBe(7);
	expect(compacting.usage.inputTokens).toBe(200 + 300 + 400 + 150 + 200 + 250 + 300 + 300);
	expect(compacting.usage.outputTokens).toBe(50);

	// The same script, a slot that knows no window, and the limit is never reached.
	const without = harness(turns, { limits: { tokens: 2_000 } });
	const plain = await without.run();
	expect(plain.reason).toBe("done");
	expect(plain.usage.inputTokens).toBe(200 + 300 + 400 + 150 + 200 + 250 + 300 + 350);
});

test("CMP15 a first message over the window fails with input_too_large", async () => {
	const huge = "x".repeat(2_000);
	const over = harness([call("c1", "finish", 10)], {
		window: 200,
		compaction: { reserveTokens: 100, keepTokens: 100 },
		input: huge,
	});
	const result = await over.run();
	expect(result.reason).toBe("failed");
	expect(result.reason === "failed" ? result.error?.code : "").toBe("bad_request");
	const message = result.reason === "failed" ? (result.error?.message ?? "") : "";
	expect(message).toContain("input_too_large");
	// It says how large the conversation was and what the window is.
	expect(message).toContain("500");
	expect(message).toContain("200");
	// No summary could have helped, so no request was made.
	expect(over.model.requests).toHaveLength(0);

	const entries = await entriesOf(over.storage);
	const last = entries.at(-1);
	expect(last).toMatchObject({ type: "status", state: "failed", detail: "input_too_large" });
});

test("CMP16 oversized older results are cut for the summarizer, and the record keeps them", async () => {
	const huge = "x".repeat(40_000);
	// The first result is 40k characters, which is 10000 estimated tokens. The second
	// turn reports a window's worth of input tokens, so the trigger fires before the
	// third turn and folds the huge result into the summary.
	const turns: ScriptedTurn[] = [
		call("c1", "read", 0),
		call("c2", "look", 100_000),
		call("c3", "finish", 100_000),
	];
	const run = harness(turns, {
		window: 100_000,
		read: huge,
		summaries: [{ text: "the summary" }],
		compaction: { reserveTokens: 0, keepTokens: 100 },
	});
	expect((await run.run()).reason).toBe("done");

	const requests = compactionRequests(run.model);
	expect(requests).toHaveLength(1);
	const material = requests[0]?.messages[0];
	const text = material?.role === "user" ? material.text : "";
	// The old result was cut to the per-entry cap, and the material says so.
	expect(text).toContain("[cut for the summary:");
	expect(text.length).toBeLessThan(huge.length);

	// The record still holds what the model saw, whole.
	const entries = await entriesOf(run.storage);
	const first = entries.find((entry) => entry.type === "tool_message");
	expect(first?.type === "tool_message" ? first.content.length : 0).toBe(huge.length);
});

test("CMP14 the summary's usage survives a resume, so a limit means the same either way", async () => {
	const turns: ScriptedTurn[] = [
		call("c1", "read", 200),
		call("c2", "look", 300),
		call("c3", "read", 400),
		call("c4", "look", 150),
		call("c5", "read", 200),
		call("c6", "read", 250),
		call("c7", "read", 300),
		call("c8", "finish", 350),
	];
	const summaries = [{ text: "the summary", usage: usage(300, 50) }];
	const whole = harness(turns, { window: 600, summaries });
	const uninterrupted = await whole.run();
	expect(uninterrupted.reason).toBe("done");
	const read = await whole.storage.read();
	const lines = read.ok ? read.value : [];
	const compactionAt = lines.findIndex((line) => line.includes('"type":"compaction"'));
	expect(compactionAt).toBeGreaterThan(0);

	// A kill right after the compaction entry, so the summary's own cost is on the
	// record and nothing else about the run has moved on.
	const clock = fakeClock();
	const inner = memoryStorage();
	const dying = crashingStorage(inner, { at: compactionAt + 1, when: "after" });
	const first = scriptedModel(turns, { clock, position: "sequence", summaries });
	first.contextWindow = 600;
	void runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [
			toolReturning("read", "x".repeat(400)),
			toolReturning("look", "y".repeat(400)),
			createFinishTool(),
		],
		model: first,
		storage: dying,
		clock,
		ids: counterIds(),
		compaction: { reserveTokens: 100, keepTokens: 100 },
	});
	await until(() => dying.appends() >= compactionAt + 1);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const killed = await inner.read();
	expect(killed.ok).toBe(true);

	// The record says how many turns were taken, which is where the script picks up.
	const turnsTaken = (await entriesOf(inner)).filter(
		(entry) => entry.type === "assistant_message",
	).length;
	const restarted = scriptedModel(turns, {
		clock,
		position: "sequence",
		startTurn: turnsTaken,
		summaries,
	});
	restarted.contextWindow = 600;
	const resumed = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [
			toolReturning("read", "x".repeat(400)),
			toolReturning("look", "y".repeat(400)),
			createFinishTool(),
		],
		model: restarted,
		storage: inner,
		clock,
		ids: counterIds(),
		compaction: { reserveTokens: 100, keepTokens: 100 },
		resume: { lines: killed.ok ? killed.value : [], by: "person" },
	});
	expect(resumed.reason).toBe("done");
	// The same run, the same spend, whichever side of the interruption it is asked on.
	expect(resumed.usage).toEqual(uninterrupted.usage);
});
