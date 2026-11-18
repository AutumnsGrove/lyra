import { expect, test } from "vitest";

import { createFinishTool, coverageCheck } from "./finish.js";
import { isPlainObject } from "./json.js";
import { readRecord, runHarness } from "./run-harness.testing.js";
import { defineTool, type Tool } from "./tool.js";

/** The rows are in `docs/recipes-and-tools.md`, FIN01 to FIN06. */

interface Page {
	covered: string[];
}

const expected = ["c1", "c2"];

function cover(): Tool {
	return defineTool({
		name: "cover",
		description: "Say a commit is covered by a line.",
		parameters: {
			type: "object",
			properties: { handle: { type: "string" } },
			required: ["handle"],
		} as const,
		async execute(args) {
			return {
				isError: false,
				content: `covered ${args.handle}`,
				details: { handle: args.handle },
			};
		},
		apply(state: Page, _args, outcome) {
			const details = outcome.details;
			const handle =
				isPlainObject(details) && typeof details["handle"] === "string"
					? details["handle"]
					: "";
			return { covered: [...state.covered, handle] };
		},
	});
}

function tools(wanted: readonly string[] = expected): Tool[] {
	return [
		cover(),
		createFinishTool<Page>({
			check: (state, skipped) =>
				coverageCheck({
					expected: wanted,
					covered: state.covered,
					label: "commits",
					skipped,
				}),
		}),
	];
}

const start = () => ({ message: "build the page", state: { covered: [] } });

test("FIN01 finish before the work is done is refused, and the model is asked again", async () => {
	const harness = runHarness(
		[
			{ toolCalls: [{ id: "f1", name: "finish", args: {} }] },
			{ toolCalls: [{ id: "c1", name: "cover", args: { handle: "c1" } }] },
			{ toolCalls: [{ id: "f2", name: "finish", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "cover", args: { handle: "c2" } }] },
			{ toolCalls: [{ id: "f3", name: "finish", args: {} }] },
		],
		() => tools(),
	);

	const result = await harness.run({ setup: start, inputValue: "day" });
	expect(result.reason).toBe("done");

	const record = await readRecord(harness.storage);
	const finishes = record.entries.filter(
		(entry) => entry.type === "tool_message" && entry.toolCallId.startsWith("f"),
	);
	expect(finishes).toHaveLength(3);
	const first = finishes[0];
	expect(first?.type === "tool_message" ? first.isError : false).toBe(true);
	expect(first?.type === "tool_message" ? first.content : "").toContain(
		"not covered yet: 2 commits (c1, c2)",
	);
	const last = finishes[2];
	expect(last?.type === "tool_message" ? last.done : undefined).toBe(true);
});

test("FIN02 an accepted finish ends the run done and is saved as done", async () => {
	const harness = runHarness(
		[
			{ toolCalls: [{ id: "c1", name: "cover", args: { handle: "c1" } }] },
			{ toolCalls: [{ id: "c2", name: "cover", args: { handle: "c2" } }] },
			{ toolCalls: [{ id: "f1", name: "finish", args: {} }] },
		],
		() => tools(),
	);

	const result = await harness.run({ setup: start, inputValue: "day" });
	expect(result.reason).toBe("done");
	const record = await readRecord(harness.storage);
	const finish = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "f1",
	);
	expect(finish?.type === "tool_message" ? finish.isError : true).toBe(false);
	expect(finish?.type === "tool_message" ? finish.done : undefined).toBe(true);
});

test("FIN03 a skip with a reason is accepted and the reason is saved", async () => {
	const harness = runHarness(
		[
			{ toolCalls: [{ id: "c1", name: "cover", args: { handle: "c1" } }] },
			{
				toolCalls: [
					{
						id: "f1",
						name: "finish",
						args: {
							skipped: [{ handle: "c2", reason: "a merge commit, nothing to say" }],
						},
					},
				],
			},
		],
		() => tools(),
	);

	const result = await harness.run({ setup: start, inputValue: "day" });
	expect(result.reason).toBe("done");
	const record = await readRecord(harness.storage);
	const finish = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "f1",
	);
	const details = finish?.type === "tool_message" ? finish.details : undefined;
	expect(details).toEqual({
		skipped: [{ handle: "c2", reason: "a merge commit, nothing to say" }],
	});
});

test("FIN04 a skip with no reason is refused, and the run does not end", async () => {
	const harness = runHarness(
		[
			{
				toolCalls: [
					{
						id: "f1",
						name: "finish",
						args: { skipped: [{ handle: "c1", reason: "  " }] },
					},
				],
			},
			{ toolCalls: [{ id: "f2", name: "finish", args: {} }] },
		],
		() => tools([]),
	);

	const result = await harness.run({ setup: start, inputValue: "day" });
	expect(result.reason).toBe("done");
	const record = await readRecord(harness.storage);
	const refused = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "f1",
	);
	if (refused?.type !== "tool_message") {
		throw new Error("the refusal was not saved");
	}
	expect(refused.isError).toBe(true);
	expect(refused.content).toContain("needs a reason");
	expect(refused.content).toContain("c1");
});

test("FIN05 a model that cannot satisfy the check parks as stuck", async () => {
	const refused = { toolCalls: [{ id: "f1", name: "finish", args: {} }] };
	const harness = runHarness([refused, refused, refused], () => tools());

	const result = await harness.run({ setup: start, inputValue: "day" });
	expect(result.reason).toBe("parked");
	expect(result.parkedReason).toBe("stuck");
	expect(result.parkedDetail).toContain("repeated_failure");
});

test("FIN06 the coverage message is sorted, capped, and says how many are missing", () => {
	const first = coverageCheck({
		expected: ["i12", "i3", "i7", "i9"],
		covered: ["i9"],
		label: "issues",
	});
	const shuffled = coverageCheck({
		expected: ["i9", "i7", "i3", "i12"],
		covered: ["i9"],
		label: "issues",
	});
	expect(first).toEqual(shuffled);
	expect(first).toEqual({
		ok: false,
		message: "not covered yet: 3 issues (i12, i3, i7)",
	});

	const many = coverageCheck({
		expected: Array.from({ length: 20 }, (_, index) => `c${index}`),
		covered: [],
		label: "commits",
	});
	expect(many.ok).toBe(false);
	if (!many.ok) {
		expect(many.message).toContain("not covered yet: 20 commits");
		expect(many.message).toContain("and 8 more");
	}

	const one = coverageCheck({ expected: ["c1"], covered: [], label: "commits" });
	expect(one).toEqual({ ok: false, message: "not covered yet: 1 commit (c1)" });
	expect(coverageCheck({ expected, covered: ["c2", "c1"], label: "commits" })).toEqual({
		ok: true,
	});
});
