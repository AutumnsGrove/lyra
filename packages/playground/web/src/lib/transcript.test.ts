import { expect, test } from "vitest";

import { EMPTY_TRANSCRIPT } from "./playground.js";
import { transcriptFrom } from "./transcript.js";

/**
 * The rows are in `docs/playground.md`: PGS18 and PGS23.
 *
 * The subject is a record, not a stream: this is what a reload draws. The entries are
 * the shapes `docs/record.md`'s code writes (`packages/lyra/src/record/entries.ts`),
 * copied here as data so a change in the record's own types is a compile error in the
 * page rather than a silently empty transcript.
 */

const AT = 1_000;
const USER = (text: string): Record<string, unknown> => ({
	type: "user_message",
	label: "task",
	text,
});
const ASSISTANT = (text: string, toolCalls: unknown[] = [], reasoning?: string, ts = AT) => ({
	type: "assistant_message",
	text,
	ts,
	...(reasoning === undefined ? {} : { reasoning }),
	toolCalls,
	model: "a-model",
	usage: { inputTokens: 1, outputTokens: 2, ...(text === "" ? {} : { cost: { amount: 0.5 } }) },
	finishReason: "tool_calls",
});
const TOOL = (content: string, callId = "c1", isError = false, ts = AT + 120) => ({
	type: "tool_message",
	ts,
	toolCallId: callId,
	isError,
	content,
});
const STATUS = (state: string, extra: Record<string, unknown> = {}) => ({
	type: "status",
	state,
	...extra,
});

test("PGS18 a record rebuilds into the conversation a person had", () => {
	const transcript = transcriptFrom([
		{ type: "header" },
		USER("what time is it?"),
		ASSISTANT("Let me look.", [{ id: "c1", name: "now", arguments: "{}" }], "the clock"),
		TOOL("2026-11-25T00:00:00.000Z"),
		ASSISTANT("It is midnight.", [], undefined),
		STATUS("done"),
	]);

	// A call and its result are one row, so the transcript is the conversation rather
	// than a second list of answers.
	expect(transcript.rows.map((row) => row.kind)).toEqual([
		"person",
		"assistant",
		"tool",
		"assistant",
	]);
	expect(transcript.rows[0]).toEqual({ kind: "person", text: "what time is it?" });
	// A tool's own entry names only the call id, so the name comes from the assistant
	// entry that made the call. The duration is the two entries' own times.
	expect(transcript.rows[2]).toEqual({
		kind: "tool",
		name: "now",
		callId: "c1",
		arguments: "{}",
		at: AT,
		result: "2026-11-25T00:00:00.000Z",
		isError: false,
		durationMs: 120,
	});
	expect(transcript.status).toEqual({ state: "done", turns: 2, costUsd: 1 });
});

test("PGS18 an empty record is an empty transcript, and a kind the page does not know is skipped", () => {
	expect(transcriptFrom([])).toEqual(EMPTY_TRANSCRIPT);
	// A record written by a later build: an entry kind this page has no rule for must
	// leave the rest of the conversation alone.
	const transcript = transcriptFrom([
		{ type: "header" },
		USER("hello"),
		{ type: "a_kind_from_the_future", text: "ignore me" },
		ASSISTANT("hi"),
	]);
	expect(transcript.rows).toEqual([
		{ kind: "person", text: "hello" },
		{ kind: "assistant", text: "hi" },
	]);
});

test("PGS23 a parked status says why, and a failed one is not drawn as done", () => {
	const parked = transcriptFrom([
		USER("do it"),
		STATUS("parked", { reason: "limit", detail: "tokens" }),
	]);
	expect(parked.status).toEqual({ state: "parked", detail: "limit: tokens" });
	// The rows the person already has are still there: a parked run is not a lost one.
	expect(parked.rows).toEqual([{ kind: "person", text: "do it" }]);

	const failed = transcriptFrom([STATUS("failed", { reason: "internal" })]);
	expect(failed.status.state).toBe("failed");
	// A status entry's own reason is the detail a status line shows, whether or not it
	// carries the second half a limit does.
	expect(failed.status.detail).toBe("internal");
});

test("PGS23 a tool that failed is drawn as an error, and a blank answer makes no row", () => {
	const transcript = transcriptFrom([
		ASSISTANT("", [{ id: "c1", name: "calculator", arguments: '{"a":1}' }]),
		TOOL("cannot divide by zero", "c1", true),
		// A call whose result never came: the record holds the call, so the page draws
		// it, and a resume is what explains it. A blank assistant row would say nothing.
		ASSISTANT("", [{ id: "c2", name: "now" }]),
	]);
	expect(transcript.rows).toEqual([
		{
			kind: "tool",
			name: "calculator",
			callId: "c1",
			arguments: '{"a":1}',
			at: AT,
			result: "cannot divide by zero",
			isError: true,
			durationMs: 120,
		},
		// A call with no result keeps its row and says so, rather than disappearing: the
		// record holds the call, and a stop or a kill is what explains the gap.
		{ kind: "tool", name: "now", callId: "c2", at: AT },
	]);
	// No assistant row was pushed for either empty message, so the tool rows are the
	// whole of what the record says.
	expect(transcript.rows.some((row) => row.kind === "assistant")).toBe(false);
});

test("PGS25 a rebuilt call carries the same duration the live stream did", () => {
	// The live path measures `tool_end.ts - tool_call.ts`; the rebuild measures
	// `tool_message.ts - assistant_message.ts`. Both are the record's entry times, so a
	// reload shows the number the run showed.
	const transcript = transcriptFrom([
		ASSISTANT("", [{ id: "c1", name: "now" }], undefined, 7_000),
		TOOL("now", "c1", false, 7_045),
	]);
	expect(transcript.rows[0]).toMatchObject({ at: 7_000, durationMs: 45 });
});

test("PGS24 a rebuild keeps the first result when a record holds two", () => {
	// The live reducer fills the first unanswered row and never overwrites it; the
	// rebuild must do the same, or a reload could draw a different answer from the run
	// that produced it (found in review on #89).
	const transcript = transcriptFrom([
		ASSISTANT("", [{ id: "c1", name: "now" }]),
		TOOL("first", "c1", false, 1_100),
		TOOL("second", "c1", false, 1_200),
	]);
	expect(transcript.rows).toHaveLength(1);
	expect(transcript.rows[0]).toMatchObject({ result: "first", durationMs: 100 });
});
