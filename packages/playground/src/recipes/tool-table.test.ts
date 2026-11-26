import { expect, test } from "vitest";

import { runTask } from "@autumnsgrove/lyra";
import { counterIds, memoryStorage } from "@autumnsgrove/lyra/memory";
import { FAKE_CLOCK_START, fakeClock, scriptedModel } from "@autumnsgrove/lyra/testkit";

import { calculatorTool, nowTool, toolTableRecipe } from "./tool-table.js";

/**
 * The rows are in `docs/playground.md`: PGS06 and PGS07.
 *
 * The subject is the first recipe with tools that do something, and the two tools it
 * brings. Nothing here reaches the network or a real clock: `now` reads the fake clock,
 * and the one full run is scripted.
 */

const clock = fakeClock();

/** The call a tool would receive, which is what the loop fills in. */
function context(callId = "c1") {
	return {
		signal: new AbortController().signal,
		runId: "run-1",
		callId,
		callKey: `run-1\u0000${callId}`,
		state: undefined,
	};
}

test("PGS06 tool-table is the recipe the page starts, and its tools divide by policy", () => {
	const recipe = toolTableRecipe({ clock });

	expect(recipe.name).toBe("tool-table");
	// Slice 5 is a changed tool set, so the pin's version moves with it (decision 91).
	expect(recipe.version).toBe(3);
	expect(recipe.tools.map((tool) => tool.spec.name)).toEqual([
		"now",
		"calculator",
		"notes_read",
		"notes_list",
		"flaky",
		"slow",
		"big_result",
		"fetch_page",
		"hostile_page",
		"notes_write",
		"notes_delete",
		"ask_person",
		"propose_summary",
		"finish",
	]);

	// The finish is a real done-check, not a tool that borrowed the name: a run cannot
	// claim to be done through anything else.
	const finish = recipe.tools.find((tool) => tool.spec.name === "finish");
	expect(finish?.finish).toBe(true);

	// Reads are allowed and parallel, so several calls from one reply show up as several
	// rows in flight (decision 154); an `apply` would make `defineTool` refuse the
	// pairing, and none of them has one.
	const reads = [
		"now",
		"calculator",
		"notes_read",
		"notes_list",
		"flaky",
		"slow",
		"big_result",
		"fetch_page",
		"hostile_page",
	];
	for (const name of reads) {
		const tool = recipe.tools.find((candidate) => candidate.spec.name === name);
		expect(tool?.policy, name).toBe("allow");
		expect(tool?.parallel, name).toBe(true);
		expect(tool?.apply, name).toBeUndefined();
	}
	for (const name of ["notes_write", "notes_delete"]) {
		const tool = recipe.tools.find((candidate) => candidate.spec.name === name);
		expect(tool?.policy, name).toBe("ask");
		expect(tool?.apply, name).toBeDefined();
	}
	// The question is its own stop, not a member of a group: a batch that includes it
	// parks where the question falls (APR05), so it is deliberately not `parallel`.
	const asking = recipe.tools.find((tool) => tool.spec.name === "ask_person");
	expect(asking?.policy).toBe("allow");
	expect(asking?.parallel).toBeUndefined();
});

test("PGS06 the recipe starts with no notes, and its state is the person's first message", () => {
	const recipe = toolTableRecipe({ clock });
	const setup = recipe.setup;
	expect(setup).toBeDefined();
	if (setup === undefined) {
		return;
	}
	expect(setup("hello")).toEqual({ message: "hello", state: { notes: {} } });
	// The page can send JSON as well as text, because a future picker might; it is
	// flattened to the message the model reads rather than dropped.
	expect(setup({ question: "hi" }).message).toBe('{"question":"hi"}');
});

test("PGS07 now answers the run's own clock, so a test can pin it", async () => {
	const tool = nowTool(clock);
	const outcome = await tool.execute({}, context());

	expect(outcome.isError).toBe(false);
	expect(outcome.content).toBe(new Date(FAKE_CLOCK_START).toISOString());
});

test("PGS07 calculator does arithmetic and keeps the result the model can read", async () => {
	const tool = calculatorTool();
	const cases = [
		{ a: 2, b: 3, op: "+", expected: "5" },
		{ a: 2, b: 3, op: "-", expected: "-1" },
		{ a: 2.5, b: 4, op: "*", expected: "10" },
		{ a: 5, b: 2, op: "/", expected: "2.5" },
	];

	for (const { a, b, op, expected } of cases) {
		const outcome = await tool.execute({ a, b, op }, context());
		expect(outcome.isError, `${a} ${op} ${b}`).toBe(false);
		expect(outcome.content).toBe(expected);
	}
});

test("PGS07 calculator refuses a division by zero as a result the model can correct", async () => {
	const tool = calculatorTool();
	const outcome = await tool.execute({ a: 1, b: 0, op: "/" }, context());

	// An ordinary error result rather than a throw: the loop hands the message back and
	// the model tries something else, which is what decision 21 asks for.
	expect(outcome.isError).toBe(true);
	expect(outcome.content).toContain("zero");
});

test("PGS07 calculator refuses a result it cannot write as a number", async () => {
	const tool = calculatorTool();
	const outcome = await tool.execute({ a: 1e308, b: 1e308, op: "*" }, context());

	// Infinity is not JSON and not a number the model can use, so it is an error rather
	// than the string "Infinity" arriving in the record as if it were an answer.
	expect(outcome.isError).toBe(true);
	expect(outcome.content).toContain("finite");
});

test("PGS07 calculator refuses arguments its schema does not allow", async () => {
	const tool = calculatorTool();

	// A string number, a missing operand and an operator that is not one of the four are
	// all refused with a message, and none of them throws out of the tool.
	const bad: unknown[] = [
		{ a: "2", b: 3, op: "+" },
		{ a: 2, op: "+" },
		{ a: 2, b: 3, op: "^" },
		{},
	];
	for (const args of bad) {
		const outcome = await tool.execute(args, context());
		expect(outcome.isError, JSON.stringify(args)).toBe(true);
		expect(outcome.content.length).toBeGreaterThan(0);
	}
});

test("PGS06 a scripted run of tool-table calls the tools and finishes through the loop", async () => {
	const recipe = toolTableRecipe({ clock });
	const storage = memoryStorage();
	const model = scriptedModel(
		[
			{ toolCalls: [{ id: "c1", name: "now", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "calculator", args: { a: 6, b: 7, op: "*" } }] },
			{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
		],
		{ clock },
	);

	const result = await runTask({
		runId: "run-1",
		task: recipe.name,
		host: "packages/playground",
		input: "what time is it, and what is 6 times 7",
		system: recipe.instructions,
		tools: recipe.tools,
		model,
		storage,
		clock,
		ids: counterIds(),
	});

	expect(result.reason).toBe("done");
	expect(result.turns).toBe(3);

	const saved = await storage.read();
	expect(saved.ok).toBe(true);
	if (!saved.ok) {
		return;
	}
	const record = saved.value.join("\n");
	// Both results are in the record the way the page will read them back, and the
	// calculator's answer is the tool's own text rather than the model's paraphrase.
	expect(record).toContain(new Date(FAKE_CLOCK_START).toISOString());
	expect(record).toContain("42");
});
