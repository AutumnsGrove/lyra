import { expect, test } from "vitest";

import { createFinishTool } from "../testkit/index.js";
import { stampTool } from "./recipe.js";
import { readRecord, runHarness } from "./run-harness.testing.js";
import { defineTool, type InferSchema } from "./tool.js";

/** The rows are in `docs/recipes-and-tools.md`, TOL01 to TOL06. */

const addLineSchema = {
	type: "object",
	properties: {
		repo: { type: "string" },
		text: { type: "string" },
		count: { type: "integer" },
		kind: { type: "string", enum: ["bug", "feat"] },
	},
	required: ["repo", "text"],
} as const;

function addLine(ran: string[]) {
	return defineTool({
		name: "add_line",
		description: "Add a line to the page.",
		parameters: addLineSchema,
		async execute(args, ctx) {
			ran.push(ctx.callId);
			return { isError: false, content: `added a line about ${args.repo}` };
		},
	});
}

test("TOL01 a valid call reaches the tool with the values the model sent", async () => {
	const ran: string[] = [];
	const tool = addLine(ran);
	const harness = runHarness(
		[
			{
				toolCalls: [
					{
						id: "c1",
						name: "add_line",
						args: { repo: "lyra", text: "a line", kind: "bug" },
					},
				],
			},
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
		() => [tool, createFinishTool()],
	);

	const result = await harness.run();
	expect(result.reason).toBe("done");
	expect(ran).toEqual(["c1"]);
	const record = await readRecord(harness.storage);
	const saved = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "c1",
	);
	expect(saved?.type === "tool_message" ? saved.content : undefined).toBe(
		"added a line about lyra",
	);
});

test("TOL02 an invalid call never reaches the tool, and the message says what to fix", async () => {
	const ran: string[] = [];
	const harness = runHarness(
		[
			{
				toolCalls: [
					{ id: "c1", name: "add_line", args: { repo: 7, text: "a line", extra: true } },
				],
			},
			{
				toolCalls: [{ id: "c2", name: "add_line", args: { repo: "lyra", text: "a line" } }],
			},
			{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
		],
		() => [addLine(ran), createFinishTool()],
	);

	const result = await harness.run();
	expect(result.reason).toBe("done");
	// The refusal ran nothing; the corrected call ran once.
	expect(ran).toEqual(["c2"]);

	const record = await readRecord(harness.storage);
	const refused = record.entries.find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "c1",
	);
	if (refused?.type !== "tool_message") {
		throw new Error("the refusal was not saved");
	}
	expect(refused.isError).toBe(true);
	expect(refused.content).toContain("invalid arguments:");
	expect(refused.content).toContain("arguments.repo: expected string, got number");
	expect(refused.content).toContain(
		"arguments.extra: not allowed (allowed: repo, text, count, kind)",
	);
	expect(refused.details).toEqual({ code: "bad_request" });
});

test("TOL03 the same invalid call three times parks the run as stuck", async () => {
	const ran: string[] = [];
	const bad = {
		toolCalls: [{ id: "c1", name: "add_line", args: { repo: "lyra" } }],
	};
	const harness = runHarness([bad, bad, bad], () => [addLine(ran), createFinishTool()]);

	const result = await harness.run();
	expect(ran).toEqual([]);
	expect(result.reason).toBe("parked");
	expect(result.parkedReason).toBe("stuck");
	expect(result.parkedDetail).toContain("repeated_failure");
});

test("TOL04 a schema this build cannot compile is refused when the tool is defined", () => {
	expect(() =>
		defineTool({
			name: "broken",
			description: "a tool with a regex",
			parameters: { type: "object", properties: { repo: { type: "string", pattern: "^a" } } },
			async execute() {
				return { isError: false, content: "never" };
			},
		}),
	).toThrow(/pattern/);
});

test("TOL05 the tool-set hash follows the schema, not the description", async () => {
	const first = addLine([]);
	const reworded = defineTool({
		name: "add_line",
		description: "A much better description of the same tool.",
		parameters: addLineSchema,
		async execute() {
			return { isError: false, content: "same shape" };
		},
	});
	const changed = defineTool({
		name: "add_line",
		description: "Add a line to the page.",
		parameters: {
			type: "object",
			properties: { repo: { type: "string" }, text: { type: "string" } },
			required: ["repo", "text"],
		} as const,
		async execute() {
			return { isError: false, content: "a narrower shape" };
		},
	});

	expect((await stampTool(reworded.spec)).hash).toBe((await stampTool(first.spec)).hash);
	expect((await stampTool(changed.spec)).hash).not.toBe((await stampTool(first.spec)).hash);
});

test("TOL06 the inferred type has what the schema requires", () => {
	type Args = InferSchema<typeof addLineSchema>;

	const everything: Args = { repo: "lyra", text: "a line", count: 2, kind: "bug" };
	const requiredOnly: Args = { repo: "lyra", text: "a line" };
	// @ts-expect-error a required property cannot be left out.
	const missing: Args = { text: "a line" };
	// An integer is a number at the type level; its wholeness is the validator's job (SCH19).
	const fraction: Args = { repo: "lyra", text: "a line", count: 1.5 };
	// @ts-expect-error kind is only one of the enum's values.
	const otherKind: Args = { repo: "lyra", text: "a line", kind: "chore" };

	expect(everything.count).toBe(2);
	expect(requiredOnly.kind).toBeUndefined();
	expect([missing, fraction, otherKind].length).toBe(3);
});

test("TOL13 a tool that changes the recipe's state cannot opt in to running in parallel", () => {
	// A group of calls reads one state, and `apply` is the only writer, so a tool
	// that opted in with an `apply` is a tool author's mistake rather than a slower
	// recipe (decision 154).
	expect(() =>
		defineTool({
			name: "add_line",
			description: "Add a line and remember it.",
			parameters: addLineSchema,
			parallel: true,
			async execute() {
				return { isError: false, content: "added a line" };
			},
			apply(state: unknown) {
				return state;
			},
		}),
	).toThrow(/parallel/);

	// The positive case: the same tool with no `apply` is accepted, so the refusal
	// above is about the combination rather than about the flag.
	const readOnly = defineTool({
		name: "read_page",
		description: "Read a page.",
		parameters: addLineSchema,
		parallel: true,
		async execute() {
			return { isError: false, content: "the page" };
		},
	});
	expect(readOnly.parallel).toBe(true);
});
