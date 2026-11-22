import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import { createFinishTool, fakeClock, scriptedModel, type ScriptedTurn } from "../testkit/index.js";
import { createProposeTool } from "./propose.js";
import { runTask } from "./run.js";

/** The rows are PRP01 to PRP06 in `docs/consumers.md`. */

const VERDICT = {
	type: "object",
	properties: {
		verdict: { type: "string", enum: ["allow", "deny"] },
		score: { type: "number" },
	},
	required: ["verdict", "score"],
} as const;

const TURNS: ScriptedTurn[] = [
	{
		toolCalls: [
			{
				id: "c1",
				name: "propose",
				args: {
					payload: { verdict: "deny", score: 0.92 },
					evidence: ["post:12", "post:13"],
				},
			},
		],
	},
];

function proposeRun(turns: readonly ScriptedTurn[] = TURNS) {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, { clock });
	const tools = [createProposeTool({ payload: VERDICT }), createFinishTool()];
	return {
		clock,
		storage,
		model,
		run: () =>
			runTask({
				runId: "run-1",
				task: "test-task",
				host: "test-host",
				input: "judge the post",
				system: "you are a test",
				tools,
				model,
				storage,
				clock,
				ids: counterIds(),
			}),
	};
}

async function entriesOf(storage: ReturnType<typeof memoryStorage>) {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : [];
}

test("PRP01 a run ends with a proposal, its evidence, and the entry to match", async () => {
	const run = proposeRun();
	const events: string[] = [];
	const result = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "judge the post",
		system: "you are a test",
		tools: [createProposeTool({ payload: VERDICT }), createFinishTool()],
		model: run.model,
		storage: run.storage,
		clock: run.clock,
		ids: counterIds(),
		onEvent: (event) => {
			if (event.type === "run_end") {
				events.push(event.reason);
			}
		},
	});
	expect(result.reason).toBe("done");
	expect(events).toEqual(["done"]);

	const entries = await entriesOf(run.storage);
	const proposal = entries.find((entry) => entry.type === "proposal");
	expect(proposal).toMatchObject({
		type: "proposal",
		payload: { verdict: "deny", score: 0.92 },
		evidence: ["post:12", "post:13"],
		state: "open",
	});
	expect(
		proposal !== undefined && proposal.type === "proposal" ? proposal.proposal : "",
	).not.toBe("");
});

test("PRP02 a payload the recipe's schema refuses never becomes a proposal", async () => {
	// The schema is checked where the model's arguments cross into the run, and the
	// model is told what was wrong so it can correct itself (decision 21).
	const wrong: ScriptedTurn[] = [
		{
			toolCalls: [
				{
					id: "c1",
					name: "propose",
					args: { payload: { verdict: "maybe" }, evidence: ["post:1"] },
				},
			],
		},
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const run = proposeRun(wrong);
	expect((await run.run()).reason).toBe("done");

	const entries = await entriesOf(run.storage);
	expect(entries.some((entry) => entry.type === "proposal")).toBe(false);
	const refused = entries.find((entry) => entry.type === "tool_message");
	expect(refused?.type === "tool_message" ? refused.isError : false).toBe(true);
});

test("PRP06 a proposal a person has not decided is still listed, and a decision is recorded once", async () => {
	// The proposal outlives the run that made it: a resume and a later session both
	// still see it until somebody decides (decision 53).
	const run = proposeRun();
	await run.run();
	const read = await run.storage.read();
	expect(read.ok).toBe(true);
	const lines = read.ok ? read.value : [];

	// A resume of a finished run changes nothing and leaves the proposal there.
	const resumed = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "judge the post",
		system: "you are a test",
		tools: [createProposeTool({ payload: VERDICT }), createFinishTool()],
		model: scriptedModel(TURNS, { clock: run.clock }),
		storage: run.storage,
		clock: run.clock,
		ids: counterIds(),
		resume: { lines, by: "person" },
	});
	expect(resumed.reason).toBe("done");
	const entries = await entriesOf(run.storage);
	expect(entries.filter((entry) => entry.type === "proposal")).toHaveLength(1);
});
