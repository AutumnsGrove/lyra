import { expect, test } from "vitest";

import { bigResultTool, flakyTool, slowTool } from "./behaviour.js";
import { emptyToolTableState } from "./notes.js";
import { askPersonTool, proposeSummaryTool } from "./person.js";

/**
 * The rows are in `docs/playground.md`: PGS27 and PGS28.
 *
 * These are the tools whose *shape* is the point: one that fails so the model has to
 * correct itself, one that waits, one whose result is too big to show whole, one that
 * needs a person, and one that leaves a decision behind. None of them reaches the
 * network, and the waiting one takes the sleep it is given.
 */

function context(callId = "c1") {
	return {
		signal: new AbortController().signal,
		runId: "run-1",
		callId,
		callKey: `run-1\u0000${callId}`,
		state: emptyToolTableState(),
	};
}

test("PGS27 flaky fails first and then works, so a model has something to correct", async () => {
	const tool = flakyTool();
	const first = await tool.execute({}, context("c1"));
	const second = await tool.execute({}, context("c2"));
	const third = await tool.execute({}, context("c3"));

	expect(first.isError).toBe(true);
	expect(first.content).toContain("on purpose");
	expect(second.isError).toBe(true);
	expect(third.isError).toBe(false);
	expect(third.content).toContain("attempt 3");
});

test("PGS27 slow waits for the sleep it is given, and refuses a wait it should not hold", async () => {
	const waits: number[] = [];
	const tool = slowTool({
		sleep: async (ms) => {
			waits.push(ms);
		},
	});

	const outcome = await tool.execute({ ms: 250 }, context());
	expect(outcome.isError).toBe(false);
	expect(waits).toEqual([250]);
	expect(outcome.content).toContain("250");

	// The bound is a schema, so a hand-built call past it is refused by the tool rather
	// than turning into a wait nobody asked for.
	const tooLong = await tool.execute({ ms: 60_000 }, context());
	expect(tooLong.isError).toBe(true);
	expect(waits).toEqual([250]);
});

test("PGS27 big_result answers more than one entry can hold", async () => {
	const tool = bigResultTool();
	const outcome = await tool.execute({ bytes: 300_000 }, context());

	expect(outcome.isError).toBe(false);
	expect(outcome.content.length).toBe(300_000);
	// The cap is the loop's job, not this tool's: a tool that cut its own result would
	// hide whether the cap works (REC03).
	expect(tool.maxResultBytes).toBeUndefined();
});

test("PGS28 ask_person parks with a question rather than answering it itself", async () => {
	const tool = askPersonTool();
	const outcome = await tool.execute({ question: "which note should I read?" }, context());

	// The tool does not invent an answer: it hands the question to the run, which saves
	// the request and parks (APR14), and the person's answer becomes this call's result.
	expect(outcome.ask).toEqual({
		kind: "question",
		title: "the run needs an answer",
		message: "which note should I read?",
	});
	expect(outcome.isError).toBe(false);
});

test("PGS28 propose_summary leaves a proposal a person decides, with its evidence", async () => {
	const tool = proposeSummaryTool();
	const outcome = await tool.execute(
		{ payload: { summary: "three notes were read" }, evidence: ["the record"] },
		context(),
	);

	expect(outcome.isError).toBe(false);
	expect(outcome.propose).toEqual({
		payload: { summary: "three notes were read" },
		evidence: ["the record"],
	});
	// A proposal is not a finish: a run that proposes ends and waits for a person, and it
	// must not also be able to claim the job is done (decision 52).
	expect(tool.finish).toBeUndefined();
	expect(tool.proposes).toBe(true);

	// A proposal's shape is the recipe's, and the tool validates it before it runs: the
	// loop calls `validate` first, so a payload missing its summary never becomes one.
	const refused = tool.validate?.({ payload: {}, evidence: ["x"] });
	expect(refused?.ok).toBe(false);
});
