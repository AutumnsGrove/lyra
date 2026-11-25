import { expect, test } from "vitest";

import { loadRecord } from "./load.js";
import type { AssistantMessageEntry, RecordEntry, RecordHeader } from "./entries.js";
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

/**
 * REC04 regression, found by the committed corpus (issue #41). The search for how
 * much text to keep assumes that keeping none of it fits, and measures that
 * pessimistically with the widest marker. The check before the search measured the
 * structure *without* a marker in the text, so there was a window -- a small cap, a
 * long id, a big details block -- where that check passed, no amount of text fitted
 * with the marker, and the function returned the marker on top of an empty field:
 * a line one byte over its cap.
 *
 * The line this test leans on is still "never over the cap". Its refusal claim did
 * not survive #77: with every cutoff field gone the structure is 165 bytes, so at 200
 * the save fits and refusing it failed a run for size, which REC04 forbids.
 */
test("REC04 an entry cut down to nothing is saved, never as a line over the cap", () => {
	const entry: RecordEntry = {
		type: "tool_message",
		id: "e8",
		parent: null,
		ts: START,
		toolCallId: "c1",
		isError: false,
		content: "x".repeat(4_000),
		details: { count: 12 },
	};
	const fitted = fitEntry(entry, 200);
	// Against the pre-fix code this was a fit of 201 bytes, so this is the assertion
	// that catches the bug: no line over the cap ever comes back as a fit.
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(200);
	// And what it answers now is the save the cap allows: the details and then the
	// content go, the entry says which field it lost and what it took with it.
	expect(fitted.refused).toBeUndefined();
	expect(utf8Length(fitted.line)).toBe(165);
	if (fitted.entry.type !== "tool_message") {
		throw new Error("the fitted entry is not a tool message");
	}
	expect(fitted.entry.truncated).toEqual({ field: "content", droppedBytes: 4_012 });
	expect(loadRecord([encodeHeader(header()), fitted.line]).ok).toBe(true);
});

/**
 * REC04, the other direction: a refusal must not take a save that fits. The gate
 * before the search has to measure the marker the entry *would* carry, not the
 * widest one it could ever carry, or an entry whose marker-only line is inside the
 * cap is refused and the run fails for size — which REC04 says must never happen.
 * Found in review, after the fix above over-corrected.
 */
test("REC04 an entry whose marker-only line fits is cut, not refused", () => {
	const entry: RecordEntry = {
		type: "tool_message",
		id: "e8",
		parent: null,
		ts: START,
		toolCallId: "c1",
		isError: false,
		content: "x".repeat(4_000),
		details: { count: 12 },
	};
	// 201 bytes holds the line with the field emptied and its marker in place; 200 is
	// one short of it, which is the over-cap bug above.
	const fitted = fitEntry(entry, 201);
	expect(fitted.refused).toBeUndefined();
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(201);
});

test("REC02 a field that loses everything it held is removed, not left as an empty string", () => {
	// Both fields are over the cap on their own, so the reason reasoning goes whole:
	// emptying it cannot make room, and its bytes join the total. What it must not do
	// is leave `reasoning: ""`, because a client reading the record then cannot tell
	// an empty trace from no trace at all (EVT09, found in review on pull request #76).
	const entry: RecordEntry = {
		type: "assistant_message",
		id: "e2",
		parent: "e1",
		ts: START,
		text: "t".repeat(2_000),
		reasoning: "r".repeat(2_000),
		toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }],
		model: "fake/model",
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "tool_calls",
	};

	const fitted = fitEntry(entry, 1_024);
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(1_024);
	if (fitted.entry.type !== "assistant_message") {
		throw new Error("the fitted entry is not an assistant message");
	}
	expect(fitted.entry).not.toHaveProperty("reasoning");
	// The bytes it lost are still counted, and the marker names the field that was cut.
	expect(fitted.entry.truncated?.droppedBytes).toBeGreaterThan(2_000);
	expect(fitted.entry.text).toMatch(/truncated/);
});

/**
 * The turn from #77: a 2.2 KB assistant message whose trace is 2 KB of it. Dropping
 * the trace whole leaves 237 bytes, and the marker that says what went brings that to
 * 291 — so every cap from 291 up holds the turn with nothing but the trace gone.
 */
function traceHeavyTurn(): AssistantMessageEntry {
	return {
		type: "assistant_message",
		id: "e2",
		parent: "e1",
		ts: START,
		text: "Done.",
		reasoning: "r".repeat(2_000),
		toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }],
		model: "fake/model",
		usage: { inputTokens: 1, outputTokens: 1 },
		finishReason: "tool_calls",
	};
}

test("REC04 an entry that fits once a field is dropped whole is saved, not refused", () => {
	// The candidate loop walked largest first, dropped a field whenever emptying it
	// could not help on its own, and refused after the loop without ever re-checking
	// what the drops had left: 291 bytes of turn refused at every cap from 291 to 314,
	// which is a save REC04 allows turned into a failed run (#77).
	for (const cap of [291, 300, 310]) {
		const fitted = fitEntry(traceHeavyTurn(), cap);

		expect(fitted.refused, `cap ${cap}`).toBeUndefined();
		expect(utf8Length(fitted.line)).toBeLessThanOrEqual(cap);
		if (fitted.entry.type !== "assistant_message") {
			throw new Error("the fitted entry is not an assistant message");
		}
		// The trace went whole rather than being cut, and the entry says so: the field
		// it lost and the bytes it took with it.
		expect(fitted.entry).not.toHaveProperty("reasoning");
		expect(fitted.entry.truncated?.field).toBe("reasoning");
		expect(fitted.entry.truncated?.droppedBytes).toBeGreaterThanOrEqual(2_000);
		// What was saved is still a record that reads back.
		expect(loadRecord([encodeHeader(header()), fitted.line]).ok).toBe(true);
	}
});

test("REC04 a cap too small for the marker itself still refuses, and says why", () => {
	// What cannot fit at 280 is the marker, not the content: the turn with the trace
	// and its text gone is 232 bytes, and the marker naming the drop brings it to 281.
	// REC04 refuses only the structure counting the marker it would need, so this is
	// that case, and the refusal says so rather than failing quietly.
	const withoutTrace = { ...traceHeavyTurn() };
	delete withoutTrace.reasoning;
	expect(utf8Length(encodeEntry(withoutTrace))).toBe(237);
	const smallestMarked: AssistantMessageEntry = {
		...withoutTrace,
		text: "",
		truncated: { field: "text", droppedBytes: 2_005 },
	};
	expect(utf8Length(encodeEntry(smallestMarked))).toBe(281);

	const fitted = fitEntry(traceHeavyTurn(), 280);
	expect(fitted.refused).toMatch(/structure/);
});

test("REC04 a refusal never hides a save: every cap that can hold the marked structure is saved", () => {
	// The rule the loop has to keep, swept rather than sampled: refusing is the only
	// way a save can fail for size, so a refusal is allowed only when even the
	// smallest line that says what went — every cutoff field gone, the marker naming
	// the cheapest one — is over the cap (#77).
	const withoutTrace = { ...traceHeavyTurn() };
	delete withoutTrace.reasoning;
	const smallestMarked = utf8Length(
		encodeEntry({
			...withoutTrace,
			text: "",
			truncated: { field: "text", droppedBytes: 2_005 },
		}),
	);

	for (let cap = 200; cap <= 320; cap += 1) {
		const fitted = fitEntry(traceHeavyTurn(), cap);
		if (fitted.refused === undefined) {
			expect(utf8Length(fitted.line), `cap ${cap}`).toBeLessThanOrEqual(cap);
		} else {
			// A refusal's own line is the emptied structure, which may be over the cap:
			// what could not fit was that plus the marker. That is the case to refuse.
			expect(
				smallestMarked,
				`cap ${cap} refused a ${smallestMarked}-byte save`,
			).toBeGreaterThan(cap);
		}
	}
});
