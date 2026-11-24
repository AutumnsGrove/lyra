import { describe, expect, test } from "vitest";

import { defineRecipe } from "../core/define-recipe.js";
import { createFinishTool as finishedTool } from "../core/finish.js";
import { createFinishTool, toolReturning, type ScriptedTurn } from "./index.js";
import { decodeScenario, runScenario, type Scenario, type ScenarioTool } from "./scenario.js";

/** The rows are in `docs/engineering-practices.md`, "Spec rows: the scenario runner". */

function scenario(overrides: Partial<Scenario> = {}): Scenario {
	return {
		name: "a read, then a finish",
		task: "scenario-test",
		system: "you are being tested",
		input: "read the issue",
		tools: [{ name: "read", behavior: "ok", content: "the issue body" }],
		model: [
			{ toolCalls: [{ id: "c1", name: "read", args: { number: 1 } }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		expectEvents: [
			{ type: "run_start" },
			{ type: "tool_end", call_id: "c1", is_error: false },
			{ type: "run_end", reason: "done" },
		],
		expectRecord: [
			{ type: "user_message", label: "task", text: "read the issue" },
			{ type: "tool_message", toolCallId: "c1", isError: false },
			{ type: "status", state: "done" },
		],
		...overrides,
	};
}

test("SCN01 a scenario runs and every expectation matches", async () => {
	const outcome = await runScenario(scenario());

	expect(outcome.problems).toEqual([]);
	expect(outcome.result.reason).toBe("done");
	expect(outcome.record?.entries.length).toBeGreaterThan(0);
});

test("SCN01 a scenario prompt with no tools still runs against finish", async () => {
	const outcome = await runScenario(
		scenario({
			tools: [],
			model: [{ toolCalls: [{ id: "c1", name: "finish" }] }],
			expectEvents: [{ type: "run_end", reason: "done" }],
			expectRecord: [{ type: "status", state: "done" }],
		}),
	);
	expect(outcome.problems).toEqual([]);
});

test("SCN06 a host runs its own recipe through a scenario file", async () => {
	// The case #59 exists for: a recipe that lives in the host, named by the file, so
	// the file stays the source of truth rather than a TypeScript copy of it.
	const shelf = defineRecipe({
		name: "shelf",
		version: 1,
		instructions: "read the shelf, then finish",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "read the shelf", state: {} }),
		tools: [
			toolReturning("read", "the shelf", { safeToRepeat: true }),
			finishedTool({ check: () => ({ ok: true }) }),
		],
	});
	const outcome = await runScenario(
		scenario({
			recipe: "shelf",
			input: {},
			tools: [],
			model: [
				{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
				{ toolCalls: [{ id: "c2", name: "finish" }] },
			],
			expectEvents: [
				{ type: "tool_end", call_id: "c1", is_error: false },
				{ type: "run_end", reason: "done" },
			],
			expectRecord: [
				{ type: "user_message", label: "task", text: "read the shelf" },
				{ type: "tool_message", toolCallId: "c1", isError: false, content: "the shelf" },
				{ type: "status", state: "done" },
			],
		}),
		{ recipes: new Map([[shelf.name, shelf]]) },
	);

	expect(outcome.problems).toEqual([]);
	expect(outcome.result.reason).toBe("done");
	// The recipe's own instructions and tools ran, not the scenario's defaults.
	expect(outcome.record?.header.task).toBe("shelf");
});

test("SCN06 a recipe nobody provided is named rather than reported as a failed run", async () => {
	// A host's mistake, so it says so instead of reporting a mismatch nobody can act
	// on. The message lists what was available, which is the proof that both the
	// host's map and the testkit's own were consulted.
	const shelf = defineRecipe({
		name: "shelf",
		version: 1,
		instructions: "read the shelf",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "read the shelf", state: {} }),
		tools: [finishedTool({ check: () => ({ ok: true }) })],
	});
	const missing = runScenario(scenario({ recipe: "nobody", input: {}, tools: [] }), {
		recipes: new Map([[shelf.name, shelf]]),
	});
	await expect(missing).rejects.toThrow(/names the recipe "nobody"/);
	await expect(missing).rejects.toThrow(/shelf, timeline-test/);
});

test("SCN02 a mismatch is reported with what was expected and what came", async () => {
	const outcome = await runScenario(
		scenario({
			expectEvents: [{ type: "tool_end", call_id: "c1", is_error: true }],
		}),
	);

	expect(outcome.problems.length).toBeGreaterThan(0);
	const report = outcome.problems.join("\n");
	expect(report).toMatch(/tool_end/);
	expect(report).toMatch(/is_error/);
	expect(report).toMatch(/expected true, got false/);
});

test("SCN02 a record expectation that never comes says so, and the run's ending is stated", async () => {
	const outcome = await runScenario(
		scenario({
			expectRecord: [{ type: "status", state: "parked" }],
		}),
	);

	expect(outcome.problems.length).toBeGreaterThan(0);
	const report = outcome.problems.join("\n");
	expect(report).toMatch(/no record entry matching/);
	expect(report).toMatch(/the run ended done/);
});

test("SCN03 a malformed scenario is refused with the field named", () => {
	const cases: { value: unknown; field: RegExp }[] = [
		{ value: 5, field: /must be an object/ },
		{ value: {}, field: /scenario\.name/ },
		{ value: { name: "x", input: "y" }, field: /scenario\.model/ },
		{ value: { name: "x", input: "y", model: [] }, field: /scenario\.model/ },
		{
			value: {
				name: "x",
				input: "y",
				model: [{}],
				tools: [{ name: "t", behavior: "explode" }],
			},
			field: /scenario\.tools\[0\]\.behavior/,
		},
		{
			value: { name: "x", input: "y", model: [{ finish_reason: "sideways" }] },
			field: /scenario\.model\[0\]\.finish_reason/,
		},
		{
			value: { name: "x", input: "y", model: [{ tool_calls: [{ name: "read" }] }] },
			field: /scenario\.model\[0\]\.tool_calls\[0\]\.id/,
		},
		{ value: { name: "x", input: "y", model: [{}], abort_after: 0 }, field: /abort_after/ },
		{ value: { name: "x", input: "y", model: [{}], abort_after: 1.5 }, field: /abort_after/ },
		{ value: { name: 5, input: "y", model: [{}] }, field: /scenario\.name/ },
		{ value: { name: "x", input: 5, model: [{}] }, field: /scenario\.input/ },
		{ value: { name: "x", input: "y", task: 5, model: [{}] }, field: /scenario\.task/ },
		{ value: { name: "x", input: "y", system: 5, model: [{}] }, field: /scenario\.system/ },
		{ value: { name: "x", input: "y", model: [{}], tools: {} }, field: /scenario\.tools/ },
		{
			value: { name: "x", input: "y", model: [{}], tools: [5] },
			field: /scenario\.tools\[0\]/,
		},
		{
			value: { name: "x", input: "y", model: [{}], tools: [{ behavior: "ok" }] },
			field: /scenario\.tools\[0\]\.name/,
		},
		{
			value: {
				name: "x",
				input: "y",
				model: [{}],
				tools: [{ name: "t", behavior: "ok", content: 5 }],
			},
			field: /scenario\.tools\[0\]\.content/,
		},
		{
			value: {
				name: "x",
				input: "y",
				model: [{}],
				tools: [{ name: "t", behavior: "slow", ms: -1 }],
			},
			field: /scenario\.tools\[0\]\.ms/,
		},
		{ value: { name: "x", input: "y", model: [5] }, field: /scenario\.model\[0\]/ },
		{
			value: { name: "x", input: "y", model: [{ text: 5 }] },
			field: /scenario\.model\[0\]\.text/,
		},
		{ value: { name: "x", input: "y", model: [{ reasoning: 5 }] }, field: /reasoning/ },
		{ value: { name: "x", input: "y", model: [{ tool_calls: {} }] }, field: /tool_calls/ },
		{
			value: { name: "x", input: "y", model: [{ tool_calls: [5] }] },
			field: /tool_calls\[0\]/,
		},
		{
			value: { name: "x", input: "y", model: [{ tool_calls: [{ id: "c1" }] }] },
			field: /tool_calls\[0\]\.name/,
		},
		{ value: { name: "x", input: "y", model: [{ delay_ms: -5 }] }, field: /delay_ms/ },
		{ value: { name: "x", input: "y", model: [{ usage: 5 }] }, field: /usage/ },
		{ value: { name: "x", input: "y", model: [{ usage: {} }] }, field: /input_tokens/ },
		{ value: { name: "x", input: "y", model: [{ failures: {} }] }, field: /failures/ },
		{ value: { name: "x", input: "y", model: [{ failures: [5] }] }, field: /failures/ },
		{
			value: { name: "x", input: "y", model: [{ failures: [{ code: "nonsense" }] }] },
			field: /failures\.code/,
		},
		{
			value: { name: "x", input: "y", model: [{ failures: [{ message: 5 }] }] },
			field: /failures\.message/,
		},
		{
			value: { name: "x", input: "y", model: [{}], expect_events: {} },
			field: /expect_events/,
		},
		{
			value: { name: "x", input: "y", model: [{}], expect_events: [5] },
			field: /expect_events\[0\]/,
		},
		{
			value: { name: "x", input: "y", model: [{}], expect_record: {} },
			field: /expect_record/,
		},
	];

	for (const { value, field } of cases) {
		const decoded = decodeScenario(value);
		expect(decoded.ok).toBe(false);
		if (!decoded.ok) {
			expect(decoded.error.code).toBe("bad_request");
			expect(decoded.error.message).toMatch(field);
		}
	}
});

test("SCN03 a scenario this build understands decodes with its defaults filled in", () => {
	const decoded = decodeScenario({
		name: "minimal",
		input: "go",
		model: [{ tool_calls: [{ id: "c1", name: "finish" }] }],
	});

	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}
	expect(decoded.value.task).toBe("scenario");
	expect(decoded.value.system).toBe("you are being tested");
	expect(decoded.value.tools).toEqual([]);
	expect(decoded.value.expectEvents).toEqual([]);
	expect(decoded.value.expectRecord).toEqual([]);
	expect(decoded.value.model).toHaveLength(1);
});

test("SCN03 a scenario with every field decodes the fields it carries", () => {
	const decoded = decodeScenario({
		name: "everything",
		task: "the task",
		system: "the system",
		input: "go",
		tools: [{ name: "read", behavior: "slow", content: "read it", ms: 250 }],
		model: [
			{
				text: "thinking",
				reasoning: "because",
				tool_calls: [{ id: "c1", name: "read", args: { number: 1 } }],
				usage: { input_tokens: 10, output_tokens: 5 },
				finish_reason: "length",
				delay_ms: 100,
				failures: [{ code: "timeout", message: "slow down", retryable: true }],
			},
		],
		expect_events: [{ type: "run_end" }],
		expect_record: [{ type: "status" }],
		abort_after: 3,
	});

	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}
	expect(decoded.value.tools[0]).toEqual({
		name: "read",
		behavior: "slow",
		content: "read it",
		ms: 250,
	});
	expect(decoded.value.model[0]).toEqual({
		text: "thinking",
		reasoning: "because",
		toolCalls: [{ id: "c1", name: "read", args: { number: 1 } }],
		usage: { inputTokens: 10, outputTokens: 5 },
		finishReason: "length",
		delayMs: 100,
		failures: [{ code: "timeout", message: "slow down", retryable: true }],
	});
	expect(decoded.value.abortAfter).toBe(3);
	expect(decoded.value.expectEvents).toHaveLength(1);
	expect(decoded.value.expectRecord).toHaveLength(1);
});

test("SCN03 the tool behaviors a scenario can ask for each reach the runner", async () => {
	const behaviors: ScenarioTool["behavior"][] = ["ok", "error", "throw", "slow"];
	const turns: ScriptedTurn[] = [
		{
			toolCalls: behaviors.map((behavior, index) => ({
				id: `c${index}`,
				name: `tool_${behavior}`,
			})),
		},
		{ toolCalls: [{ id: "done", name: "finish" }] },
	];
	const outcome = await runScenario(
		scenario({
			tools: behaviors.map((behavior) => ({
				name: `tool_${behavior}`,
				behavior,
				content: `${behavior} result`,
				ms: 500,
			})),
			model: turns,
			expectEvents: [{ type: "run_end", reason: "done" }],
			expectRecord: [{ type: "tool_message", toolCallId: "c2", isError: true }],
		}),
	);

	// c0 is ok, c1 returns an error, c2 throws, and c3 (slow) finishes on the fake clock.
	expect(outcome.result.reason).toBe("done");
	expect(outcome.problems).toEqual([]);
});

test("the scenario runner adds the finish tool, so a file does not have to declare it", () => {
	// `createFinishTool` is what the runner appends; this keeps the coupling visible.
	expect(createFinishTool().spec.name).toBe("finish");
});

describe("the scenario runner's clock", () => {
	test("a delay in the model is moved past, not waited for", async () => {
		const outcome = await runScenario(
			scenario({
				model: [{ toolCalls: [{ id: "c1", name: "finish" }], delayMs: 5_000 }],
				expectEvents: [{ type: "run_end", reason: "done" }],
			}),
		);
		expect(outcome.problems).toEqual([]);
		expect(outcome.result.reason).toBe("done");
	});
});
