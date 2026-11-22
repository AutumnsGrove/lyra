import fc from "fast-check";
import { expect, test } from "vitest";

import type { RecordEntry, ToolMessageEntry, UserMessageEntry } from "../record/entries.js";
import { chooseCut, entryTokens, estimateTokens } from "./compaction.js";
import { historyArbitrary } from "./compaction-generators.testing.js";

/** The rows are in `docs/context-size.md`, "The rows compaction is built against". */

function user(id: string, text: string): UserMessageEntry {
	return { type: "user_message", id, parent: null, ts: 1, label: "task", text };
}

function tool(id: string, content: string): ToolMessageEntry {
	return {
		type: "tool_message",
		id,
		parent: null,
		ts: 1,
		toolCallId: `c-${id}`,
		isError: false,
		content,
	};
}

function assistant(id: string, text: string, calls: number): RecordEntry {
	return {
		type: "assistant_message",
		id,
		parent: null,
		ts: 1,
		text,
		toolCalls: Array.from({ length: calls }, (_, index) => ({
			id: `${id}-c${index}`,
			name: "read",
			arguments: "{}",
		})),
		model: "generated/model",
		usage: { inputTokens: 0, outputTokens: 0 },
		finishReason: calls > 0 ? "tool_calls" : "stop",
	};
}

/** The cost of the suffix starting at an entry, which is what a budget compares to. */
function suffixTokens(entries: readonly RecordEntry[], index: number): number {
	return entries.slice(index).reduce((sum, entry) => sum + entryTokens(entry), 0);
}

test("estimateTokens is four characters to a token, rounded up", () => {
	expect(estimateTokens("")).toBe(0);
	expect(estimateTokens("abcd")).toBe(1);
	expect(estimateTokens("abcde")).toBe(2);
	// A part of the conversation that the model never sees costs nothing.
	expect(
		entryTokens({
			type: "status",
			id: "e1",
			parent: null,
			ts: 1,
			state: "running",
		}),
	).toBe(0);
});

test("CMP01 a normal cut keeps the most recent work the budget allows", () => {
	// Each step is about 25 tokens: a 80-character result is 20, and the turn's
	// own text makes up the rest.
	const entries: RecordEntry[] = [
		user("e1", "the job"),
		assistant("e2", "", 1),
		tool("e3", "x".repeat(80)),
		assistant("e4", "", 1),
		tool("e5", "x".repeat(80)),
		assistant("e6", "", 1),
		tool("e7", "x".repeat(80)),
	];

	// The last step alone is 22 tokens, so a budget of 40 keeps exactly that one.
	const cut = chooseCut(entries, 40);
	expect(cut).toEqual({ firstKept: "e6", index: 5, replaces: 5 });

	// One more step's worth of budget keeps one more step.
	const wider = chooseCut(entries, 60);
	expect(wider?.firstKept).toBe("e4");
	expect(wider?.replaces).toBe(3);
});

test("CMP01 a cut never starts the kept suffix on a tool result", () => {
	// A budget that lands exactly between a call and its result moves back to the
	// call, so the model is never shown an answer to a question it cannot see.
	const entries: RecordEntry[] = [
		user("e1", "the job"),
		assistant("e2", "", 1),
		tool("e3", "x".repeat(400)),
		assistant("e4", "", 1),
		tool("e5", "x".repeat(400)),
	];
	const cut = chooseCut(entries, 100);
	expect(cut).toBeDefined();
	expect(entries[cut?.index ?? 0]?.type).not.toBe("tool_message");
	expect(cut?.firstKept).toBe("e4");
});

test("CMP02 property: any history and any budget give a cut that starts a whole step", () => {
	fc.assert(
		fc.property(historyArbitrary(), fc.nat({ max: 400 }), (entries, keepTokens) => {
			const cut = chooseCut(entries, keepTokens);
			const fits = suffixTokens(entries, 0) <= keepTokens;
			// A cut needs a second step to start on: with one step the only thing to
			// summarize is the whole history, which is what the view already is.
			const laterStep = entries.some(
				(entry, index) =>
					index > 0 &&
					(entry.type === "user_message" || entry.type === "assistant_message"),
			);
			if (fits || !laterStep) {
				expect(cut).toBeUndefined();
				return;
			}
			expect(cut).toBeDefined();
			if (cut === undefined) {
				return;
			}

			// The pointer names an entry in this history, and the count matches it.
			expect(entries[cut.index]?.id).toBe(cut.firstKept);
			expect(cut.replaces).toBe(cut.index);
			expect(cut.index).toBeGreaterThan(0);
			expect(cut.index).toBeLessThan(entries.length);

			// The suffix is a whole step: it starts with a message and every tool
			// result in it keeps the turn that asked for it.
			const kept = entries.slice(cut.index);
			expect(["user_message", "assistant_message"]).toContain(entries[cut.index]?.type);
			const keptCallIds = new Set<string>();
			for (const entry of kept) {
				if (entry.type === "assistant_message") {
					for (const call of entry.toolCalls) {
						keptCallIds.add(call.id);
					}
				}
				if (entry.type === "tool_message") {
					// Every result in the suffix keeps the call it answers.
					expect(keptCallIds.has(entry.toolCallId)).toBe(true);
				}
			}

			// It fits the budget, or no later step start would have fitted either.
			const keptTokens = suffixTokens(entries, cut.index);
			if (keptTokens > keepTokens) {
				for (let later = cut.index + 1; later < entries.length; later += 1) {
					const type = entries[later]?.type;
					if (type === "user_message" || type === "assistant_message") {
						expect(suffixTokens(entries, later)).toBeGreaterThan(keepTokens);
					}
				}
			}
		}),
		{ numRuns: 200 },
	);
});

test("CMP03 an empty history or one that already fits gives no cut", () => {
	expect(chooseCut([], 0)).toBeUndefined();
	expect(chooseCut([], 10_000)).toBeUndefined();

	const oneStep: RecordEntry[] = [
		user("e1", "the job"),
		{ type: "status", id: "e2", parent: "e1", ts: 1, state: "running" },
	];
	expect(chooseCut(oneStep, 10_000)).toBeUndefined();
	// Even with no budget at all there is no step to keep but the one already there.
	expect(chooseCut(oneStep, 0)).toBeUndefined();
});

test("CMP04 a history of huge steps still cuts at a step boundary", () => {
	const huge = "x".repeat(4_000);
	const entries: RecordEntry[] = [
		user("e1", huge),
		assistant("e2", huge, 1),
		tool("e3", huge),
		assistant("e4", huge, 1),
		tool("e5", huge),
		assistant("e6", huge, 1),
		tool("e7", huge),
	];

	// No step fits a budget of one token, so the cut keeps the last one whole.
	const cut = chooseCut(entries, 1);
	expect(cut).toEqual({ firstKept: "e6", index: 5, replaces: 5 });
	expect(entries.slice(cut?.index ?? 0).map((entry) => entry.type)).toEqual([
		"assistant_message",
		"tool_message",
	]);
});

test("CMP05 firstKept always names an entry the history holds", () => {
	fc.assert(
		fc.property(historyArbitrary(), fc.nat({ max: 200 }), (entries, keepTokens) => {
			const cut = chooseCut(entries, keepTokens);
			if (cut === undefined) {
				return;
			}
			expect(entries.some((entry) => entry.id === cut.firstKept)).toBe(true);
			expect(entries[cut.index]?.id).toBe(cut.firstKept);
		}),
		{ numRuns: 100 },
	);
});
