import { describe, expect, test } from "vitest";

import { defineRecipe } from "../core/define-recipe.js";
import { createFinishTool as finishedTool } from "../core/finish.js";
import { defineTool } from "../core/tool.js";
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

test("SCN06 a decoded file that names a host recipe runs that recipe", async () => {
	// The decode half of the change: the name is not checked in the decoder, so this is
	// the path a host's own file takes from YAML to a run.
	const host = defineRecipe({
		name: "shelf",
		version: 1,
		instructions: "read the shelf",
		input: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
		setup: (input) => ({ message: `read ${input.day}`, state: {} }),
		tools: [
			toolReturning("shelf_read", "the shelf", { safeToRepeat: true }),
			finishedTool({ check: () => ({ ok: true }) }),
		],
		// A limit the run must honour, which the runner used to drop (found in review).
		limits: { steps: 1 },
	});
	const decoded = decodeScenario({
		name: "a file about the host's recipe",
		task: "ignored-when-a-recipe-is-named",
		system: "ignored-too",
		recipe: "shelf",
		input: { day: "2026-11-24" },
		model: [
			{ tool_calls: [{ id: "c1", name: "shelf_read", args: {} }] },
			{ tool_calls: [{ id: "c2", name: "finish", args: {} }] },
		],
		expect_events: [{ type: "run_start" }],
		expect_record: [{ type: "user_message", text: "read 2026-11-24" }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}
	expect(decoded.value.recipe).toBe("shelf");

	// And a name the testkit has never heard of decodes, which is the other half.
	const unknown = decodeScenario({
		name: "an unknown name",
		task: "t",
		input: {},
		recipe: "somewhere-else",
		model: [{ tool_calls: [] }],
	});
	expect(unknown.ok).toBe(true);

	const outcome = await runScenario(decoded.value, { recipes: new Map([[host.name, host]]) });
	expect(outcome.problems).toEqual([]);
	// The recipe's limit is the run's: one step, so the second turn parks instead of
	// finishing, which the runner's own `steps` would have let through.
	expect(outcome.result).toMatchObject({ reason: "parked", parkedReason: "limit" });
	expect(outcome.result.parkedDetail).toBe("steps");
	expect(outcome.record?.header.task).toBe("shelf");
});

test("SCN06 a recipe's approvals reach the run, so a scenario can see the park", async () => {
	// One of the settings the runner used to drop. A recipe that asks parks, and a
	// scenario file about an approval would otherwise run straight past it.
	const host = defineRecipe({
		name: "cautious",
		version: 1,
		instructions: "write, then finish",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "write it", state: {} }),
		tools: [
			toolReturning("write", "wrote the line", { safeToRepeat: true }),
			finishedTool({ check: () => ({ ok: true }) }),
		],
		approvals: { policy: "ask" },
	});
	const decoded = decodeScenario({
		name: "a file about an approval",
		task: "cautious",
		input: {},
		recipe: "cautious",
		model: [{ tool_calls: [{ id: "c1", name: "write", args: {} }] }],
		expect_events: [{ type: "run_end", reason: "parked", parked_reason: "waiting_for_person" }],
		expect_record: [{ type: "request", kind: "approve", callId: "c1" }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}

	const outcome = await runScenario(decoded.value, { recipes: new Map([[host.name, host]]) });
	expect(outcome.problems).toEqual([]);
	expect(outcome.result).toMatchObject({
		reason: "parked",
		parkedReason: "waiting_for_person",
	});
});

test("SCN06 a recipe's stuck settings reach the run", async () => {
	// The second of the settings the runner used to drop, and one with an observable
	// difference: the default nudges the model and asks again, and this recipe says not
	// to, so the run fails with the reason it says.
	const host = defineRecipe({
		name: "quiet",
		version: 1,
		instructions: "say nothing, then finish",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "say something", state: {} }),
		tools: [finishedTool({ check: () => ({ ok: true }) })],
		stuck: { enabled: false },
	});
	const decoded = decodeScenario({
		name: "a file about the stuck safeguard",
		task: "quiet",
		input: {},
		recipe: "quiet",
		model: [{ text: "nothing to do" }],
		expect_events: [{ type: "run_end", reason: "failed" }],
		expect_record: [{ type: "status", state: "failed" }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}

	const outcome = await runScenario(decoded.value, { recipes: new Map([[host.name, host]]) });
	expect(outcome.problems).toEqual([]);
	expect(outcome.result.reason).toBe("failed");
	expect(outcome.result.reason === "failed" ? outcome.result.error?.message : "").toContain(
		"the stuck safeguard is off",
	);
});

test("SCN06 a recipe's parallel cap reaches the run, and wins over the file's", async () => {
	// The one setting the runner still dropped. Two opted-in calls run together with the
	// default cap and one after another with a recipe that says one, which is observable
	// without a clock: both starts come before the first end, or they do not.
	const order: string[] = [];
	const reading = (name: string) =>
		defineTool({
			name,
			description: name,
			parameters: { type: "object", properties: {} },
			parallel: true,
			async execute() {
				order.push(`${name}:start`);
				await Promise.resolve();
				order.push(`${name}:end`);
				return { isError: false, content: name };
			},
		});
	const recipeWith = (cap?: number) =>
		defineRecipe({
			name: "capped",
			version: 1,
			instructions: "read both",
			input: { type: "object", properties: {} },
			setup: () => ({ message: "read both", state: {} }),
			tools: [
				reading("first"),
				reading("second"),
				finishedTool({ check: () => ({ ok: true }) }),
			],
			...(cap === undefined ? {} : { maxParallelCalls: cap }),
		});
	const file = scenario({
		recipe: "capped",
		input: {},
		tools: [],
		// The file says four, so the recipe's one has to win for the run to be serial.
		maxParallelCalls: 4,
		model: [
			{
				toolCalls: [
					{ id: "c1", name: "first", args: {} },
					{ id: "c2", name: "second", args: {} },
				],
			},
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		expectEvents: [{ type: "run_end", reason: "done" }],
		expectRecord: [{ type: "status", state: "done" }],
	});

	// The positive case first: the file's four does run the two together, so the serial
	// order below is the recipe's doing and not the default's.
	order.length = 0;
	const together = await runScenario(file, { recipes: new Map([["capped", recipeWith()]]) });
	expect(together.problems).toEqual([]);
	expect(order).toEqual(["first:start", "second:start", "first:end", "second:end"]);

	order.length = 0;
	const oneByOne = await runScenario(file, { recipes: new Map([["capped", recipeWith(1)]]) });
	expect(oneByOne.problems).toEqual([]);
	expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
});

test("SCN06 a recipe's fallback model reaches the run", async () => {
	// The last of the forwarded settings, and the one that needs a model that fails: the
	// recipe names a fallback, so a run whose first model exhausts its retries moves to
	// it and the record says the move happened.
	const host = defineRecipe({
		name: "insured",
		version: 1,
		instructions: "finish",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "finish", state: {} }),
		tools: [finishedTool({ check: () => ({ ok: true }) })],
		fallbackModel: "fallback/model",
	});
	const outcome = await runScenario(
		scenario({
			recipe: "insured",
			input: {},
			tools: [],
			// The first model fails its first try and every retry, so the run moves on.
			model: [
				{
					toolCalls: [{ id: "c1", name: "finish" }],
					failures: Array.from({ length: 4 }, () => ({ retryable: true })),
				},
			],
			expectEvents: [{ type: "run_end", reason: "done" }],
			expectRecord: [{ type: "fallback", to: "fallback/model" }],
		}),
		{ recipes: new Map([[host.name, host]]) },
	);

	expect(outcome.problems).toEqual([]);
	expect(outcome.result.reason).toBe("done");
	expect(outcome.record?.entries.find((entry) => entry.type === "fallback")).toMatchObject({
		type: "fallback",
		to: "fallback/model",
	});
});

test("SCN06 the recipe's compaction wins over the file's", async () => {
	// The file's compaction is one that cuts a short run; the recipe's never cuts. The
	// file's settings are only a default for a scenario with no recipe, so the run must
	// end without a single compaction (found in review: the file's spread came later
	// and silently reversed the order).
	const host = defineRecipe({
		name: "long-memory",
		version: 1,
		instructions: "read the file, then finish",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "read it", state: {} }),
		tools: [
			toolReturning("read", "the file, all of it", { safeToRepeat: true }),
			finishedTool({ check: () => ({ ok: true }) }),
		],
		compaction: { contextWindow: 1_000_000, reserveTokens: 1_000, keepTokens: 20_000 },
	});
	const decoded = decodeScenario({
		name: "a file whose compaction should not be used",
		task: "long-memory",
		input: {},
		recipe: "long-memory",
		compaction: {
			context_window: 600,
			reserve_tokens: 100,
			keep_tokens: 2,
			summaries: [{ text: "a summary the run must never ask for" }],
		},
		model: [
			{
				tool_calls: [{ id: "c1", name: "read", args: {} }],
				usage: { input_tokens: 400, output_tokens: 10 },
			},
			{
				tool_calls: [{ id: "c2", name: "read", args: {} }],
				usage: { input_tokens: 450, output_tokens: 10 },
			},
			{
				tool_calls: [{ id: "c3", name: "read", args: {} }],
				usage: { input_tokens: 500, output_tokens: 10 },
			},
			{
				tool_calls: [{ id: "c4", name: "read", args: {} }],
				usage: { input_tokens: 550, output_tokens: 10 },
			},
			{
				tool_calls: [{ id: "c5", name: "finish", args: {} }],
				usage: { input_tokens: 600, output_tokens: 10 },
			},
		],
		expect_events: [{ type: "run_end", reason: "done" }],
		expect_record: [{ type: "status", state: "done" }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}

	const outcome = await runScenario(decoded.value, { recipes: new Map([[host.name, host]]) });
	expect(outcome.problems).toEqual([]);
	expect(outcome.result.reason).toBe("done");
	expect(outcome.record?.entries.some((entry) => entry.type === "compaction")).toBe(false);
});

test("SCN06 a host's map wins over the testkit's when both have the name", async () => {
	// The precedence the doc comment and the rows claim, which a map keyed on a name
	// only the testkit has would never show.
	const host = defineRecipe({
		name: "timeline-test",
		version: 1,
		instructions: "the host's own timeline",
		input: { type: "object", properties: {} },
		setup: () => ({ message: "build the host's page", state: {} }),
		tools: [finishedTool({ check: () => ({ ok: true }) })],
	});
	const decoded = decodeScenario({
		name: "a file whose recipe the host shadows",
		task: "shadowed",
		input: {},
		recipe: "timeline-test",
		model: [{ tool_calls: [{ id: "c1", name: "finish", args: {} }] }],
		expect_events: [{ type: "run_end", reason: "done" }],
		expect_record: [{ type: "user_message", text: "build the host's page" }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}
	const outcome = await runScenario(decoded.value, {
		recipes: new Map([[host.name, host]]),
	});
	expect(outcome.problems).toEqual([]);
});

test("SCN06 a file whose input the recipe refuses says so instead of running setup", async () => {
	const host = defineRecipe({
		name: "shelf",
		version: 1,
		instructions: "read the shelf",
		input: { type: "object", properties: { day: { type: "string" } }, required: ["day"] },
		setup: () => ({ message: "read the day", state: {} }),
		tools: [finishedTool({ check: () => ({ ok: true }) })],
	});
	const refused = runScenario(
		scenario({ recipe: "shelf", input: {}, tools: [], model: [{ toolCalls: [] }] }),
		{ recipes: new Map([[host.name, host]]) },
	);
	await expect(refused).rejects.toThrow(/gives input the recipe refuses/);
	await expect(refused).rejects.toThrow(/day/);
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
		// The recipe name may be anything a host provides, and an empty one names
		// nothing (issue #59), so these two are the decoder's whole recipe rule.
		{ value: { name: "x", input: "y", model: [{}], recipe: "" }, field: /scenario\.recipe/ },
		{ value: { name: "x", input: "y", model: [{}], recipe: "  " }, field: /scenario\.recipe/ },
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

/** A raw file, the way a YAML file reaches `decodeScenario`. */
function file(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		name: "a conversation",
		task: "scenario-conversation",
		input: "write a line, then read it back",
		tools: [{ name: "write", behavior: "ok", policy: "ask", content: "wrote one line" }],
		model: [{ tool_calls: [{ id: "c1", name: "finish" }] }],
		...overrides,
	};
}

test("SCN07 a scenario carries a conversation: two runs with an approval answered between them", async () => {
	// The shape #60's acceptance list asks for, and the one a chat page has: a run, a
	// person answering it, and the person's next word starting another run, all
	// asserted over the session's record rather than only the last run's.
	const decoded = decodeScenario(
		file({
			model: undefined,
			runs: [
				{ model: [{ tool_calls: [{ id: "c1", name: "write", args: {} }] }] },
				{
					answer: { decision: "approve" },
					model: [{ tool_calls: [{ id: "c2", name: "finish" }] }],
				},
				{
					follow_up: "read it back",
					model: [{ tool_calls: [{ id: "c3", name: "finish" }] }],
				},
			],
			expect_events: [{ type: "run_end", reason: "done" }],
			expect_record: [
				{ type: "user_message", label: "task" },
				{ type: "request", kind: "approve" },
				{ type: "request_answered", decision: "approve" },
				{ type: "tool_message", toolCallId: "c1", content: "wrote one line" },
				{ type: "user_message", label: "follow_up", text: "read it back" },
			],
		}),
	);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}

	const outcome = await runScenario(decoded.value);
	expect(outcome.problems).toEqual([]);
	expect(outcome.results.map((result) => result.reason)).toEqual(["parked", "done", "done"]);
	// A session owns one record and one run id, so the answer and the follow-up are
	// new segments of the same run rather than rival runs (decision 44). The record
	// says so: two `resumed` statuses, and every event names the one run.
	const resumed = outcome.record?.entries.filter(
		(entry) => entry.type === "status" && entry.state === "resumed",
	);
	expect(resumed).toHaveLength(2);
	expect(new Set(outcome.events.map((event) => event.run))).toEqual(new Set(["scenario"]));
});

test("SCN07 a question is answered with text, and the run carries on from it", async () => {
	// The other half of `answer:`: a decision answers an approval, and this is what a
	// person types into a question. `scenarios/conversation.yaml` drives the same shape
	// at all four levels, so this is the in-process case beside it.
	const decoded = decodeScenario(
		file({
			model: undefined,
			tools: [
				{
					name: "choose",
					behavior: "ask",
					question: { title: "which note", message: "which note should I read?" },
				},
			],
			runs: [
				{ model: [{ tool_calls: [{ id: "c1", name: "choose", args: {} }] }] },
				{
					answer: { text: "the second one" },
					model: [{ tool_calls: [{ id: "c2", name: "finish", args: {} }] }],
				},
			],
			expect_events: [{ type: "run_end", reason: "done" }],
			expect_record: [
				{ type: "request", kind: "question" },
				{ type: "request_answered", text: "the second one", decision: "approve" },
				{ type: "tool_message", toolCallId: "c1", isError: false },
				{ type: "status", state: "done" },
			],
		}),
	);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}

	const outcome = await runScenario(decoded.value);
	expect(outcome.problems).toEqual([]);
	expect(outcome.results.map((result) => result.reason)).toEqual(["parked", "done"]);
});

test("SCN08 a run that parks with nobody to answer it is named in the report", async () => {
	// A follow-up while the run is still waiting for a person is the session's `busy`
	// (CMD08), so the scenario must say which run is waiting rather than let a second
	// run go on top of it.
	const decoded = decodeScenario(
		file({
			model: undefined,
			runs: [
				{ model: [{ tool_calls: [{ id: "c1", name: "write", args: {} }] }] },
				{
					follow_up: "never mind",
					model: [{ tool_calls: [{ id: "c2", name: "finish" }] }],
				},
			],
			expect_events: [
				{ type: "run_end", reason: "parked", parked_reason: "waiting_for_person" },
			],
			expect_record: [{ type: "request", kind: "approve" }],
		}),
	);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}

	const outcome = await runScenario(decoded.value);
	expect(outcome.problems.join(" ")).toMatch(/scenario\.runs\[0\]/);
	expect(outcome.problems.join(" ")).toMatch(/waiting_for_person/);
	// The follow-up never ran: its model turns were not spent.
	expect(outcome.results).toHaveLength(1);
});

test("SCN09 a malformed runs list is refused with the field named", () => {
	const refusals: Array<[Record<string, unknown>, RegExp]> = [
		[{ runs: [] }, /runs/],
		// The first step starts the run; there is nothing for it to continue.
		[{ runs: [{ follow_up: "hello", model: [{ text: "hi" }] }] }, /runs\[0\]/],
		// Two commands in one step is ambiguous: does it answer, or start a new run?
		[
			{
				runs: [
					{ model: [{ text: "hi" }] },
					{
						answer: { decision: "approve" },
						follow_up: "and again",
						model: [{ text: "hi" }],
					},
				],
			},
			/runs\[1\]/,
		],
		// A step with no script has nothing to say when it resumes.
		[{ runs: [{ model: [{ text: "hi" }] }, { follow_up: "again" }] }, /model/],
		// An answer that carries neither a decision nor a text answers nothing.
		[
			{ runs: [{ model: [{ text: "hi" }] }, { answer: {}, model: [{ text: "hi" }] }] },
			/runs\[1\]\.answer/,
		],
	];

	// Two scripts, or two answers, in one place: neither has a winner, so neither is
	// guessed at. The rival cases above never reach these checks because their `runs:`
	// list is refused first, which is why they are listed separately here.
	refusals.push([
		{
			model: [{ tool_calls: [{ id: "c1", name: "finish" }] }],
			runs: [{ model: [{ text: "hi" }] }],
		},
		/scenario\.model and scenario\.runs/,
	]);
	refusals.push([
		{
			model: undefined,
			runs: [
				{ model: [{ text: "hi" }] },
				{ answer: { decision: "approve", text: "x" }, model: [{ text: "hi" }] },
			],
		},
		/runs\[1\]\.answer/,
	]);

	for (const [overrides, pattern] of refusals) {
		const decoded = decodeScenario(file(overrides));
		expect(decoded.ok, JSON.stringify(overrides)).toBe(false);
		if (!decoded.ok) {
			expect(decoded.error.code).toBe("bad_request");
			expect(decoded.error.message).toMatch(pattern);
		}
	}
});

test("SCN03 a single-run file still decodes, and a conversation needs no top-level model", () => {
	const single = decodeScenario(file());
	expect(single.ok).toBe(true);
	if (single.ok) {
		expect(single.value.runs).toBeUndefined();
	}

	const conversation = decodeScenario(
		file({
			model: undefined,
			runs: [
				{ model: [{ text: "first" }] },
				{ follow_up: "again", model: [{ text: "second" }] },
			],
		}),
	);
	expect(conversation.ok).toBe(true);
	if (conversation.ok) {
		expect(conversation.value.runs).toHaveLength(2);
		expect(conversation.value.runs?.[1]?.followUp).toBe("again");
	}
});
