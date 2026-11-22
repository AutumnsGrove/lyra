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
import { runTask } from "./run.js";
import { NO_PARAMETERS, defineTool } from "./tool.js";
import { counterIds, memoryStorage } from "../adapters/memory/index.js";
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

test("APR02 a call that asks parks the run with a request saved first", async () => {
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
