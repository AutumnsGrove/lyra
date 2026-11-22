import { expect, test } from "vitest";

import { executeTools } from "./execute-tools.js";
import { loadRecord } from "../record/load.js";
import {
	createFinishTool,
	executionCounter,
	fakeClock,
	scriptedModel,
	toolReturning,
	type ScriptedTurn,
} from "../testkit/index.js";
import {
	deniedByRecipe,
	deniedOutcome,
	deniedWithoutAPerson,
	isToolPolicy,
	isToolRisk,
	policyFromRisk,
	policyOf,
} from "./approval.js";
import type { Recipe } from "./define-recipe.js";
import { runTask } from "./run.js";
import { NO_PARAMETERS, defineTool } from "./tool.js";
import { counterIds, memoryStorage, memoryWaking } from "../adapters/memory/index.js";
import { createRuntime } from "./runtime.js";
import { drive } from "./run-harness.testing.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/approvals.md`, "The rows approvals is built against". */

interface Harness {
	clock: ReturnType<typeof fakeClock>;
	storage: ReturnType<typeof memoryStorage>;
	model: ReturnType<typeof scriptedModel>;
	run(
		overrides?: Partial<Parameters<typeof runTask>[0]>,
	): Promise<Awaited<ReturnType<typeof runTask>>>;
}

const TURNS: ScriptedTurn[] = [
	{ toolCalls: [{ id: "c1", name: "write", args: { line: "one" } }] },
	{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
];

function harness(tools: Tool[], turns: readonly ScriptedTurn[] = TURNS): Harness {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, { clock });
	return {
		clock,
		storage,
		model,
		run: (overrides = {}) =>
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
				ids: counterIds(),
				...overrides,
			}),
	};
}

async function entriesOf(storage: Harness["storage"]) {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : [];
}

test("APR01 an allowed call runs untouched", async () => {
	const executions = executionCounter();
	const readOnly = toolReturning("write", "wrote one line", { risk: "reads", executions });
	const run = harness(
		[readOnly, createFinishTool()],
		[
			{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
	);

	const result = await run.run();
	expect(result.reason).toBe("done");
	expect(executions.count("c1")).toBe(1);
	expect((await entriesOf(run.storage)).some((entry) => entry.type === "request")).toBe(false);
});

test("APR02 REQ01 a call that asks parks the run with a request saved first", async () => {
	const executions = executionCounter();
	const asking = toolReturning("write", "wrote one line", { policy: "ask", executions });
	const run = harness([asking, createFinishTool()]);

	const result = await run.run({ canAsk: true });
	expect(result.reason).toBe("parked");
	expect(result.parkedReason).toBe("waiting_for_person");
	expect(result.turns).toBe(1);
	// The tool never ran: the person is asked before it does.
	expect(executions.count("c1")).toBe(0);

	const entries = await entriesOf(run.storage);
	const request = entries.find((entry) => entry.type === "request");
	expect(request).toMatchObject({
		type: "request",
		kind: "approve",
		callId: "c1",
		tool: "write",
	});
	// The request comes before anything that could have been shown, and the record
	// says why the run stopped.
	expect(entries.at(-1)).toMatchObject({ type: "status", state: "parked" });
	expect(entries.at(-1)).toMatchObject({ reason: "waiting_for_person" });

	// A resume with no answer on the record parks again and writes nothing: there is
	// nothing to continue with until a person decides (the answering path is the
	// next slice).
	const written = run.storage.saved().length;
	const resumed = await run.run({
		canAsk: true,
		model: scriptedModel(TURNS, { clock: run.clock }),
		resume: { lines: run.storage.saved(), by: "person" },
	});
	expect(resumed.reason).toBe("parked");
	expect(resumed.parkedReason).toBe("waiting_for_person");
	expect(run.storage.saved()).toHaveLength(written);
});

test("APR03 a denied call never asks, and the model is told why", async () => {
	const executions = executionCounter();
	const forbidden = toolReturning("write", "wrote one line", { policy: "deny", executions });
	const run = harness([forbidden, createFinishTool()]);

	const result = await run.run({ canAsk: true });
	expect(result.reason).toBe("done");
	expect(executions.count("c1")).toBe(0);

	const entries = await entriesOf(run.storage);
	expect(entries.some((entry) => entry.type === "request")).toBe(false);
	const answer = entries.find((entry) => entry.type === "tool_message");
	expect(answer?.type === "tool_message" ? answer.isError : false).toBe(true);
	expect(answer?.type === "tool_message" ? answer.content : "").toContain("denied");
});

test("APR04 a run with no one to ask denies instead of parking", async () => {
	const executions = executionCounter();
	const asking = toolReturning("write", "wrote one line", { policy: "ask", executions });
	const run = harness([asking, createFinishTool()]);

	// No `canAsk`, which is what a headless runner is.
	const result = await run.run();
	expect(result.reason).toBe("done");
	expect(executions.count("c1")).toBe(0);
	const entries = await entriesOf(run.storage);
	expect(entries.some((entry) => entry.type === "request")).toBe(false);
	const answer = entries.find((entry) => entry.type === "tool_message");
	expect(answer?.type === "tool_message" ? answer.content : "").toContain(
		"nothing can deliver the question",
	);
});

test("APR05 the risk label sets the default, and a policy overrides it", async () => {
	// A change asks, a read does not, and an explicit policy wins over both.
	const runs = async (options: {
		risk?: "reads" | "changes" | "dangerous";
		policy?: "allow" | "ask" | "deny";
	}) => {
		const executions = executionCounter();
		const tool = toolReturning("write", "wrote", { ...options, executions });
		const run = harness([tool, createFinishTool()]);
		const result = await run.run({ canAsk: true });
		return { result, ran: executions.count("c1") };
	};

	const change = await runs({ risk: "changes" });
	expect(change.result.reason).toBe("parked");
	expect(change.ran).toBe(0);

	const dangerous = await runs({ risk: "dangerous" });
	expect(dangerous.result.reason).toBe("parked");

	const allowed = await runs({ risk: "changes", policy: "allow" });
	expect(allowed.result.reason).toBe("done");
	expect(allowed.ran).toBe(1);

	const read = await runs({ risk: "reads" });
	expect(read.result.reason).toBe("done");
	expect(read.ran).toBe(1);
});

test("APR06 a tool that says nothing about itself is allowed", async () => {
	// Every tool built so far is of this kind, and a silent tool meaning "ask"
	// would stop every existing recipe at its first call.
	const executions = executionCounter();
	const plain = toolReturning("write", "wrote", { executions });
	const run = harness([plain, createFinishTool()]);

	const result = await run.run({ canAsk: true });
	expect(result.reason).toBe("done");
	expect(executions.count("c1")).toBe(1);
});

test("APR05 a batch stops at the first call that needs an answer", async () => {
	// The calls after it were never run and have no result, so they are answered
	// once the person has decided (the next slice), not guessed at now.
	const executions = executionCounter();
	const tools = [
		toolReturning("read", "the file", { risk: "reads", executions }),
		toolReturning("write", "written", { policy: "ask", executions }),
		createFinishTool(),
	];
	const run = harness(tools, [
		{
			toolCalls: [
				{ id: "c1", name: "read", args: {} },
				{ id: "c2", name: "write", args: {} },
				{ id: "c3", name: "finish", args: {} },
			],
		},
	]);

	const result = await run.run({ canAsk: true });
	expect(result.reason).toBe("parked");
	expect(executions.count("c1")).toBe(1);
	expect(executions.count("c2")).toBe(0);
	const entries = await entriesOf(run.storage);
	expect(entries.filter((entry) => entry.type === "tool_message")).toHaveLength(1);
	expect(entries.find((entry) => entry.type === "request")).toMatchObject({ callId: "c2" });
});

// A tool that is never reached through the loop still cannot crash it.
test("the executor still owns a single call's answer", async () => {
	const clock = fakeClock();
	const calls: string[] = [];
	await executeTools({
		calls: [{ id: "c1", name: "write", arguments: "{}" }],
		tools: [toolReturning("write", "ok")],
		clock,
		signal: new AbortController().signal,
		deadlineMs: 1_000,
		runId: "run-1",
		isFinished: () => false,
		onStart: () => calls.push("start"),
		onFinish: async () => {
			calls.push("finish");
		},
	});
	expect(calls).toEqual(["start", "finish"]);
});

test("APR05 the policy's own rule, read on its own", () => {
	// The order is the rule, so it is asserted where it is decided rather than only
	// through a run: the tool's word, then its label, then the recipe, then silence.
	const made = (options: {
		policy?: "allow" | "ask" | "deny";
		risk?: "reads" | "changes" | "dangerous";
	}) =>
		defineTool({
			name: "act",
			description: "does a thing",
			parameters: NO_PARAMETERS,
			execute: async () => ({ isError: false, content: "" }),
			...options,
		});

	expect(policyOf(made({}), undefined)).toBe("allow");
	expect(policyOf(made({ risk: "reads" }), undefined)).toBe("allow");
	expect(policyOf(made({ risk: "changes" }), undefined)).toBe("ask");
	expect(policyOf(made({ risk: "dangerous" }), undefined)).toBe("ask");
	expect(policyOf(made({ risk: "changes", policy: "allow" }), undefined)).toBe("allow");
	expect(policyOf(made({}), "deny")).toBe("deny");

	expect(policyFromRisk("reads")).toBeUndefined();
	expect(policyFromRisk("changes")).toBe("ask");
	expect(isToolPolicy("ask")).toBe(true);
	expect(isToolPolicy("maybe")).toBe(false);
	expect(isToolRisk("reads")).toBe(true);
	expect(isToolRisk("loud")).toBe(false);

	expect(deniedOutcome("why").isError).toBe(true);
	expect(deniedByRecipe(made({}))).toContain("act");
	expect(deniedWithoutAPerson(made({}))).toContain("approval");
});

/**
 * A person's answer, written into the storage the way the session writes it. It
 * goes to the storage rather than to a copy of the lines, because a later resume
 * reads the storage: an answer that only existed in a test's array would have
 * settled nothing.
 */
async function answerWith(
	storage: Harness["storage"],
	request: string,
	decision: "approve" | "deny",
	note?: string,
): Promise<string[]> {
	const last = storage.saved().at(-1);
	if (last === undefined) {
		throw new Error("there is no record to answer");
	}
	const parent = JSON.parse(last) as { id?: string };
	const entry: Record<string, unknown> = {
		type: "request_answered",
		id: `e_answer_${request}`,
		parent: parent.id ?? null,
		ts: 100,
		request,
		decision,
	};
	if (note !== undefined) {
		entry["note"] = note;
	}
	const saved = await storage.append(JSON.stringify(entry));
	expect(saved.ok).toBe(true);
	return storage.saved();
}

const askingTurns: ScriptedTurn[] = [
	{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
	{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
];

test("APR07 an approved call runs on the resume, and its result is the model's", async () => {
	const executions = executionCounter();
	const tools = [
		toolReturning("write", "wrote one line", { policy: "ask", executions }),
		createFinishTool(),
	];
	const run = harness(tools, askingTurns);
	const parked = await run.run({ canAsk: true });
	expect(parked.reason).toBe("parked");

	const lines = run.storage.saved();
	const request = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (request?.type !== "request") {
		throw new Error("the run did not ask");
	}
	const restarted = scriptedModel(askingTurns, { clock: run.clock });
	const resumed = await run.run({
		canAsk: true,
		model: restarted,
		resume: { lines: await answerWith(run.storage, request.request, "approve"), by: "person" },
	});

	expect(resumed.reason).toBe("done");
	expect(executions.count("c1")).toBe(1);
	// The model read the result, which is what an approval buys.
	const asked = restarted.requests
		.at(-1)
		?.messages.find((message) => message.role === "tool" && message.toolCallId === "c1");
	expect(asked?.role === "tool" ? asked.content : "").toBe("wrote one line");
});

test("APR08 a deny's note is what the model reads", async () => {
	const executions = executionCounter();
	const tools = [
		toolReturning("write", "wrote one line", { policy: "ask", executions }),
		createFinishTool(),
	];
	const run = harness(tools, askingTurns);
	await run.run({ canAsk: true });
	const request = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (request?.type !== "request") {
		throw new Error("the run did not ask");
	}

	const resumed = await run.run({
		canAsk: true,
		model: scriptedModel(askingTurns, { clock: run.clock }),
		resume: {
			lines: await answerWith(run.storage, request.request, "deny", "use the staging branch"),
			by: "person",
		},
	});

	expect(resumed.reason).toBe("done");
	// Nothing ran, and the person's own words are the result the model corrects from.
	expect(executions.count("c1")).toBe(0);
	const entries = await entriesOf(run.storage);
	const result = entries.find((entry) => entry.type === "tool_message");
	expect(result?.type === "tool_message" ? result.isError : false).toBe(true);
	expect(result?.type === "tool_message" ? result.content : "").toContain(
		"use the staging branch",
	);
});

test("APR05 the calls after an answered one still meet their own policy", async () => {
	// An approval covers the call it named. The calls the batch held are run after
	// it, and one of them can ask again.
	const executions = executionCounter();
	const tools = [
		toolReturning("write", "wrote", { policy: "ask", executions }),
		toolReturning("send", "sent", { policy: "ask", executions }),
		createFinishTool(),
	];
	const turns: ScriptedTurn[] = [
		{
			toolCalls: [
				{ id: "c1", name: "write", args: {} },
				{ id: "c2", name: "send", args: {} },
				{ id: "c3", name: "finish", args: {} },
			],
		},
	];
	const run = harness(tools, turns);
	await run.run({ canAsk: true });
	const first = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (first?.type !== "request") {
		throw new Error("the run did not ask");
	}

	const second = await run.run({
		canAsk: true,
		model: scriptedModel(turns, { clock: run.clock }),
		resume: { lines: await answerWith(run.storage, first.request, "approve"), by: "person" },
	});
	// The first call ran; the second parked rather than running unasked.
	expect(executions.count("c1")).toBe(1);
	expect(executions.count("c2")).toBe(0);
	expect(second.reason).toBe("parked");
	expect(second.parkedReason).toBe("waiting_for_person");
	const requests = (await entriesOf(run.storage)).filter((entry) => entry.type === "request");
	expect(requests).toHaveLength(2);
});

test("APR11 REQ05 a request past its timeout is denied, and the record says it expired", async () => {
	const executions = executionCounter();
	const tools = [
		toolReturning("write", "wrote", { policy: "ask", executions }),
		createFinishTool(),
	];
	const run = harness(tools, askingTurns);
	await run.run({ canAsk: true, approvals: { timeoutMs: 1_000 } });
	const request = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (request?.type !== "request") {
		throw new Error("the run did not ask");
	}
	expect(request.timeoutMs).toBe(1_000);

	// Time passes with no answer, and a resume finds the request expired.
	run.clock.advance(2_000);
	const resumed = await run.run({
		canAsk: true,
		model: scriptedModel(askingTurns, { clock: run.clock }),
		resume: { lines: run.storage.saved(), by: "wake" },
	});

	expect(resumed.reason).toBe("done");
	expect(executions.count("c1")).toBe(0);
	const entries = await entriesOf(run.storage);
	const answer = entries.find((entry) => entry.type === "request_answered");
	expect(answer).toMatchObject({ type: "request_answered", decision: "deny", timedOut: true });
});

test("APR11 a request's timeout becomes a wake, through the runtime", async () => {
	// The host's alarm is what denies an unanswered request: the run itself is
	// parked and costs nothing while it waits (decisions 23, 37).
	const clock = fakeClock();
	const storage = memoryStorage();
	const waking = memoryWaking();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(askingTurns, { clock }),
		host: "test-host",
		waking: waking.slot,
		canAsk: true,
	});
	const started = runtime.start({
		runId: "run-1",
		task: "test-task",
		input: "go",
		definition: {
			name: "test-task",
			version: 1,
			instructions: "you are a test",
			tools: [toolReturning("write", "wrote", { policy: "ask" }), createFinishTool()],
			approvals: { timeoutMs: 30_000 },
		},
	});
	expect(started.ok).toBe(true);
	if (!started.ok) {
		return;
	}
	// `canAsk` is the host's to set, and the runtime passes the definition's settings.
	const outcome = await drive(clock, started.value.outcome, 1_000);
	expect(outcome.reason).toBe("parked");

	const scheduled = waking.scheduled();
	expect(scheduled.some((wake) => wake.runId === "run-1")).toBe(true);
});

test("APR07 an answered request stops being a decision once its call has a result", async () => {
	// A record that once had an answered request must not go on answering with it:
	// the run that follows a refusal or an approval is its own business, and
	// decision 23's rule for a wake has to still hold.
	const tools = [toolReturning("write", "wrote one line", { policy: "ask" }), createFinishTool()];
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
		{ failures: [{ code: "internal", retryable: false }] },
	];
	const run = harness(tools, turns);
	await run.run({ canAsk: true });
	const request = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (request?.type !== "request") {
		throw new Error("the run did not ask");
	}

	// The approval runs the call, and the turn it leads to fails for good.
	const failed = await run.run({
		canAsk: true,
		model: scriptedModel(turns, { clock: run.clock }),
		resume: { lines: await answerWith(run.storage, request.request, "approve"), by: "person" },
	});
	expect(failed.reason).toBe("failed");
	const written = run.storage.saved().length;

	// A plain person resume now has nothing to do, and spends no turn finding out.
	const restarted = scriptedModel(turns, { clock: run.clock });
	const again = await run.run({
		canAsk: true,
		model: restarted,
		resume: { lines: run.storage.saved(), by: "person" },
	});
	expect(again.reason).toBe("failed");
	expect(restarted.requests).toHaveLength(0);
	expect(run.storage.saved()).toHaveLength(written);
});

test("APR05 an approval covers the call it named, not a later one that reuses the id", async () => {
	// A model can send the same call id twice in a run. The first answer settles the
	// first call and nothing else, so the second has to be asked about on its own.
	const executions = executionCounter();
	const tools = [
		toolReturning("write", "wrote", { policy: "ask", executions }),
		createFinishTool(),
	];
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "write", args: { line: "one" } }] },
		{ toolCalls: [{ id: "c1", name: "write", args: { line: "two" } }] },
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const run = harness(tools, turns);
	await run.run({ canAsk: true });
	const first = (await entriesOf(run.storage)).find((entry) => entry.type === "request");
	if (first?.type !== "request") {
		throw new Error("the run did not ask");
	}

	const approved = await run.run({
		canAsk: true,
		model: scriptedModel(turns, { clock: run.clock }),
		resume: { lines: await answerWith(run.storage, first.request, "approve"), by: "person" },
	});
	expect(approved.reason).toBe("parked");
	expect(executions.count("c1")).toBe(1);

	// The second call asked under the same id. A resume with no new answer parks
	// again rather than running it on the first answer.
	const again = await run.run({
		canAsk: true,
		model: scriptedModel(turns, { clock: run.clock }),
		resume: { lines: run.storage.saved(), by: "person" },
	});
	expect(again.reason).toBe("parked");
	expect(executions.count("c1")).toBe(1);
	const requests = (await entriesOf(run.storage)).filter((entry) => entry.type === "request");
	expect(requests).toHaveLength(2);
});

test("APR11 a resume that parks again keeps the timeout's wake", async () => {
	// The wake that denies an unanswered request is the only thing that ends the
	// wait, so a park must not cancel it, whichever segment parked the run.
	const clock = fakeClock();
	const storage = memoryStorage();
	const waking = memoryWaking();
	const definition: Recipe = {
		name: "test-task",
		version: 1,
		instructions: "you are a test",
		tools: [toolReturning("write", "wrote", { policy: "ask" }), createFinishTool()],
		approvals: { timeoutMs: 60_000 },
	};
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(askingTurns, { clock }),
		host: "test-host",
		waking: waking.slot,
		canAsk: true,
	});
	const started = runtime.start({ runId: "run-1", task: "test-task", input: "go", definition });
	expect(started.ok).toBe(true);
	if (!started.ok) {
		return;
	}
	expect((await drive(clock, started.value.outcome, 1_000)).reason).toBe("parked");
	expect(waking.scheduled().map((wake) => wake.runId)).toEqual(["run-1"]);

	// A person's resume with no answer parks again, and the alarm is still set.
	const resumed = await runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition,
		by: "person",
	});
	expect(resumed.ok).toBe(true);
	if (!resumed.ok) {
		return;
	}
	expect((await drive(clock, resumed.value.outcome, 1_000)).reason).toBe("parked");
	expect(waking.scheduled().map((wake) => wake.runId)).toEqual(["run-1"]);
});
