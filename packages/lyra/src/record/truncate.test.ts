import { expect, test } from "vitest";

import { loadRecord } from "./load.js";
import type { RecordEntry, RecordHeader } from "./entries.js";
import { encodeEntry, encodeHeader } from "./entries.js";
import type { JsonValue } from "../core/json.js";
import { cutText, fitEntry, utf8Length } from "./truncate.js";

/** The rows are in `docs/run-record.md`: REC01 to REC04. */

const START = 1_700_000_000_000;
const CAP = 1_048_576;

function header(): RecordHeader {
	return { type: "header", v: 1, run: "run-1", task: "timeline", startedAt: START, host: "test" };
}

function toolResult(content: string, details?: JsonValue): RecordEntry {
	const entry: RecordEntry = {
		type: "tool_message",
		id: "e1",
		parent: null,
		ts: START,
		toolCallId: "c1",
		isError: false,
		content,
	};
	if (details !== undefined) {
		entry.details = details;
	}
	return entry;
}

test("REC01 a tool result over the cap is saved truncated, with a marker giving the bytes dropped", () => {
	const entry = toolResult("x".repeat(200_000));
	const fitted = fitEntry(entry, 100_000);

	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(100_000);
	expect(fitted.entry.type).toBe("tool_message");
	if (fitted.entry.type !== "tool_message") {
		return;
	}
	expect(fitted.entry.truncated?.field).toBe("content");
	expect(fitted.entry.truncated?.droppedBytes).toBeGreaterThan(0);
	expect(fitted.entry.content).toMatch(/truncated/);
	expect(fitted.entry.content.length).toBeLessThan(200_000);

	// It is a marker in the text as well as data, so a person reading the record sees it.
	const text = fitted.entry.content;
	expect(text).toMatch(/bytes dropped/);

	// And it loads back as it was saved.
	const loaded = loadRecord([encodeHeader(header()), fitted.line]);
	expect(loaded.ok).toBe(true);
	if (loaded.ok) {
		expect(loaded.value.notes).toEqual([]);
		expect(loaded.value.entries[0]).toEqual(fitted.entry);
	}
});

test("REC01 a tool result exactly at the cap is saved unchanged", () => {
	const room = CAP - utf8Length(encodeEntry(toolResult("")));
	const entry = toolResult("x".repeat(room));
	expect(utf8Length(encodeEntry(entry))).toBe(CAP);

	const fitted = fitEntry(entry, CAP);
	expect(fitted.entry).toEqual(entry);
	expect(
		fitted.entry.type === "tool_message" ? fitted.entry.truncated : undefined,
	).toBeUndefined();
	expect(utf8Length(fitted.line)).toBe(CAP);
});

test("REC01 one byte over the cap is truncated", () => {
	const room = CAP - utf8Length(encodeEntry(toolResult("")));
	const entry = toolResult("x".repeat(room + 1));
	expect(utf8Length(encodeEntry(entry))).toBe(CAP + 1);

	const fitted = fitEntry(entry, CAP);
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(CAP);
	expect(fitted.entry.type === "tool_message" ? fitted.entry.truncated : undefined).toBeDefined();
});

test("REC02 reasoning text over the cap is truncated, and the rest of the turn survives", () => {
	const entry: RecordEntry = {
		type: "assistant_message",
		id: "e2",
		parent: "e1",
		ts: START,
		text: "the answer",
		reasoning: "r".repeat(500_000),
		toolCalls: [{ id: "c1", name: "read", arguments: '{"number":1}' }],
		model: "fake/model",
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "tool_calls",
	};
	const fitted = fitEntry(entry, 200_000);

	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(200_000);
	expect(fitted.entry.type).toBe("assistant_message");
	if (fitted.entry.type !== "assistant_message") {
		return;
	}
	expect(fitted.entry.truncated?.field).toBe("reasoning");
	expect(fitted.entry.text).toBe("the answer");
	expect(fitted.entry.toolCalls).toEqual([{ id: "c1", name: "read", arguments: '{"number":1}' }]);
	expect(fitted.entry.reasoning).toMatch(/truncated/);
});

test("REC02 a tool result's details are dropped before the content is cut", () => {
	const entry = toolResult("short content", { rows: "d".repeat(300_000) });
	const fitted = fitEntry(entry, 100_000);

	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(100_000);
	if (fitted.entry.type !== "tool_message") {
		return;
	}
	expect(fitted.entry.details).toBeUndefined();
	expect(fitted.entry.truncated?.field).toBe("details");
	expect(fitted.entry.content).toBe("short content");
});

test("REC01 a cut never splits a multibyte character", () => {
	// Each emoji is four UTF-8 bytes, so a cut placed mid-character would produce a
	// replacement character and change the text rather than shorten it.
	const entry = toolResult("😀".repeat(100_000));
	const fitted = fitEntry(entry, 50_000);

	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(50_000);
	if (fitted.entry.type !== "tool_message") {
		return;
	}
	expect(fitted.entry.content).not.toMatch(/\uFFFD/);
	// What is left is still whole emoji, plus the marker text.
	const kept = fitted.entry.content.replace(/\n…\[truncated: \d+ bytes dropped\]$/, "");
	expect(kept).toMatch(/^(😀)*$/);
});

test("REC03 an oversized user message is refused, and nothing is saved", () => {
	// The loop refuses the message before the record starts, which is asserted in
	// `core/run.test.ts` where a run can be started; this is the size rule itself.
	const big = "u".repeat(CAP + 1);
	expect(utf8Length(big)).toBeGreaterThan(CAP);
	expect(utf8Length("u".repeat(CAP))).toBe(CAP);
});

test("REC04 an entry whose structure alone is over the cap is refused rather than half-saved", () => {
	// With no content left to cut, the structure is the problem: thousands of calls
	// in one turn. Saving a turn with calls whose results cannot be paired would be
	// worse than failing the run, so this is the one truncation that gives up, and
	// it says which kind it was.
	const calls = Array.from({ length: 200 }, (_, index) => ({
		id: `c${index}`,
		name: "read",
		arguments: "{}",
	}));
	const entry: RecordEntry = {
		type: "assistant_message",
		id: "e3",
		parent: null,
		ts: START,
		text: "many calls",
		toolCalls: calls,
		model: "fake/model",
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "tool_calls",
	};
	expect(utf8Length(encodeEntry(entry))).toBeGreaterThan(1_000);

	const fitted = fitEntry(entry, 1_000);
	expect(fitted.refused).toBeDefined();
	expect(fitted.refused).toMatch(/structure/);
});

test("REC04 a second field that cannot fit even when empty is counted in the total", () => {
	// Two large arguments and a cap that only one of them can be brought under. The
	// bigger field is wiped whole, so the entry has to say how many bytes went with
	// it: a save that silently loses 1.2 KB is the kind of record a resume cannot
	// explain, because the call it replays has no arguments at all.
	const entry: RecordEntry = {
		type: "assistant_message",
		id: "e3",
		parent: null,
		ts: START,
		text: "",
		toolCalls: [
			{ id: "c1", name: "read", arguments: "a".repeat(900) },
			{ id: "c2", name: "read", arguments: "b".repeat(1_200) },
		],
		model: "fake/model",
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "tool_calls",
	};

	const fitted = fitEntry(entry, 1_000);
	expect(fitted.refused).toBeUndefined();
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(1_000);
	expect(loadRecord([encodeHeader(header()), fitted.line]).ok).toBe(true);

	// The wiped field's bytes are part of the total the marker reports.
	const truncated =
		fitted.entry.type === "assistant_message" ? fitted.entry.truncated : undefined;
	expect(truncated?.droppedBytes).toBeGreaterThanOrEqual(1_200);
	// And the call is still there, so the result that follows it is pair-able.
	expect(fitted.entry.type === "assistant_message" ? fitted.entry.toolCalls : []).toHaveLength(2);
});

test("CMP18 a cap smaller than the marker still keeps the result inside it", () => {
	// A tool's own cap is not validated by anything but itself, so a small one must
	// still mean what it says: the cut is silent when even the marker would be over
	// the budget, because a result over the cap is worse than one without a note.
	const text = "z".repeat(5_000);
	for (const cap of [1, 10, 20, 60]) {
		const cut = cutText(text, cap, "call read again with a smaller range");
		expect(cut).toBeDefined();
		expect({ cap, bytes: utf8Length(cut?.text ?? "") <= cap }).toEqual({ cap, bytes: true });
		expect(cut?.droppedBytes ?? 0).toBe(text.length - (cut?.text.length ?? 0));
		expect(cut?.droppedBytes ?? 0).toBeGreaterThan(0);
	}

	// With room for the marker, the note and the tool's hint are both there.
	const roomy = cutText(text, 200, "call read again");
	expect(roomy?.text).toContain("[truncated:");
	expect(roomy?.text).toContain("call read again");
});
