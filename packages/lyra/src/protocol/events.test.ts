import { expect, test } from "vitest";

import type { RecordEntry, RunState, StatusEntry } from "../record/entries.js";
import { projectEvents, type RecordEvent } from "./events.js";

/**
 * The projection from a record entry to the protocol's events (docs/protocol.md,
 * EVT01 to EVT03 and EVT06). A client that reconnects rebuilds what happened from
 * the record, so these tests read a hand-built record the way a client would and
 * check the events, in order, with the `seq` of the entry each came from.
 */

const T0 = 1_700_000_000_000;

/** An entry before the test helper stamps its id, parent and time on it. */
type Unstamped<T> = T extends unknown ? Omit<T, "id" | "parent" | "ts"> : never;

type Entry = Unstamped<RecordEntry>;

/** A chain of entries, one per argument, with ids and parents filled in. */
function record(...entries: readonly Entry[]): RecordEntry[] {
	return entries.map((entry, index) => ({
		...entry,
		id: `e${index}`,
		parent: index === 0 ? null : `e${index - 1}`,
		ts: T0 + index,
	})) as RecordEntry[];
}

function status(
	state: RunState,
	reason?: string,
	detail?: string,
): Omit<StatusEntry, "id" | "parent" | "ts"> {
	const entry: Omit<StatusEntry, "id" | "parent" | "ts"> = { type: "status", state };
	if (reason !== undefined) {
		entry.reason = reason;
	}
	if (detail !== undefined) {
		entry.detail = detail;
	}
	return entry;
}

const running = status("running");
const done = status("done");

const assistant: Entry = {
	type: "assistant_message",
	text: "I will read the file.",
	toolCalls: [{ id: "call-1", name: "read", arguments: '{"path":"a.md"}' }],
	model: "test-model",
	usage: { inputTokens: 10, outputTokens: 4 },
	finishReason: "tool_calls",
};

const toolMessage: Entry = {
	type: "tool_message",
	toolCallId: "call-1",
	isError: false,
	content: "the file",
};

function events(entries: readonly RecordEntry[]): RecordEvent[] {
	return projectEvents(entries, { session: "s1", run: "r1" });
}

test("EVT01 a done run ends with exactly one run_end and nothing after it", () => {
	const projected = events(record(running, assistant, toolMessage, done));

	const ends = projected.filter((event) => event.type === "run_end");
	expect(ends).toHaveLength(1);
	expect(ends[0]).toMatchObject({ type: "run_end", reason: "done", seq: 3 });
	expect(projected.at(-1)).toBe(ends[0]);
	// The events came from the record, so every one names the entry it came from.
	expect(projected.every((event) => event.session === "s1" && event.run === "r1")).toBe(true);
});

test("EVT01 a failed run ends once as failed, and a resumed segment ends on its own", () => {
	const failed = events(record(running, assistant, status("failed")));
	expect(failed.filter((event) => event.type === "run_end")).toMatchObject([
		{ reason: "failed", seq: 2 },
	]);

	// A resume continues the same run: a second segment, its own `run_start` and its
	// own `run_end`, which is what CMD07 promises the client.
	const continued = events(record(running, status("parked", "stopped"), status("resumed"), done));
	expect(continued.map((event) => event.type)).toEqual([
		"run_start",
		"parked",
		"run_end",
		"resumed",
		"run_start",
		"run_end",
	]);
	expect(continued.filter((event) => event.type === "run_end")).toMatchObject([
		{ reason: "parked", parkedReason: "stopped", seq: 1 },
		{ reason: "done", seq: 3 },
	]);
});

test("EVT02 a limit parks the run, then ends it as parked", () => {
	const projected = events(record(running, assistant, status("parked", "limit", "steps")));

	expect(projected.slice(-2)).toMatchObject([
		{ type: "parked", reason: "limit", detail: "steps", seq: 2 },
		{ type: "run_end", reason: "parked", parkedReason: "limit", detail: "steps", seq: 2 },
	]);
	// A parked run is resumable, so its record is not finished: the events stop here
	// and the run is continued by a later segment, not by anything after this.
	expect(projected.at(-1)).toMatchObject({ type: "run_end", reason: "parked" });
});

test("EVT03 the fallback model taking over is an event with the entry's own values", () => {
	const projected = events(
		record(running, { type: "fallback", from: "a", to: "b", reason: "four failures" }, done),
	);

	expect(projected.filter((event) => event.type === "fallback")).toMatchObject([
		{ from: "a", to: "b", reason: "four failures", seq: 1 },
	]);
});

test("EVT06 a resume that finds a changed tool set parks as stuck, with the change", () => {
	const projected = events(
		record(running, status("parked", "stuck", "recipe_changed: removed read (was used)")),
	);

	expect(projected.at(-2)).toMatchObject({
		type: "parked",
		reason: "stuck",
		detail: "recipe_changed: removed read (was used)",
	});
	expect(projected.at(-1)).toMatchObject({
		type: "run_end",
		reason: "parked",
		parkedReason: "stuck",
	});
});

test("EVT01 a parked reason this build does not know is reported as stuck, with the raw reason", () => {
	// A record written by a newer Lyra must not have its park guessed at, and a person
	// still has to be asked, so the unknown reason is kept where a reader can see it.
	const projected = events(record(running, status("parked", "waiting_for_person", "ui-1")));
	expect(projected.at(-2)).toMatchObject({ type: "parked", reason: "stuck" });
	expect(projected.at(-1)).toMatchObject({ type: "run_end", parkedReason: "stuck" });
});

test("EVT01 a turn is announced once, with its calls and its usage", () => {
	const projected = events(record(running, assistant, toolMessage, done));

	expect(projected.map((event) => event.type)).toEqual([
		"run_start",
		"message_end",
		"tool_call",
		"turn_end",
		"usage",
		"tool_end",
		"run_end",
	]);
	// The whole entry is announced together: one `seq` for all its events.
	expect(new Set(projected.slice(1, 5).map((event) => event.seq))).toEqual(new Set([1]));
	expect(projected[2]).toMatchObject({
		type: "tool_call",
		call: { id: "call-1", name: "read" },
	});
	expect(projected[4]).toMatchObject({ type: "usage", inputTokens: 10, outputTokens: 4 });
	// A tool's result names its tool, which the record only knows by call id.
	expect(projected[5]).toMatchObject({
		type: "tool_end",
		callId: "call-1",
		name: "read",
		isError: false,
	});
});

test("EVT01 turns count across a resumed segment, and the run_end totals the run", () => {
	const second: Entry = {
		...assistant,
		toolCalls: [],
		finishReason: "stop",
		usage: { inputTokens: 5, outputTokens: 1 },
	};
	const projected = events(
		record(
			running,
			assistant,
			toolMessage,
			status("parked", "limit", "steps"),
			status("resumed"),
			second,
			done,
		),
	);

	expect(projected.filter((event) => event.type === "turn_end")).toMatchObject([
		{ turn: 1 },
		{ turn: 2 },
	]);
	// Usage is the run's, not the segment's, because that is what a limit and a
	// resume both count against.
	expect(projected.at(-1)).toMatchObject({
		type: "run_end",
		reason: "done",
		turn: 2,
		usage: { inputTokens: 15, outputTokens: 5 },
	});
});

test("EVT01 an entry that is not an event adds none", () => {
	const projected = events(
		record(running, { type: "note", kind: "limit_unenforceable", text: "cost" }, done),
	);
	expect(projected.map((event) => event.type)).toEqual(["run_start", "run_end"]);
});

test("EVT07 a compaction entry projects to a compaction event with its seq", () => {
	const compaction: Entry = {
		type: "compaction",
		summary: "the work so far",
		firstKept: "e1",
		replaces: 3,
		usage: { inputTokens: 40, outputTokens: 10 },
		model: "test-model",
		trigger: "auto",
		instructionsHash: "abc123",
	};
	const projected = events(record(running, assistant, toolMessage, compaction, done));

	const event = projected.find((each) => each.type === "compaction");
	// The entry is the fourth, so a client reconnecting from `seq` 3 is sent it.
	expect(event).toEqual({
		type: "compaction",
		seq: 3,
		ts: T0 + 3,
		session: "s1",
		run: "r1",
		summary: "the work so far",
		replaces: 3,
		trigger: "auto",
	});
	// A summary call is not a turn, so it does not change what a turn counts.
	const end = projected.at(-1);
	expect(end?.type === "run_end" ? end.turn : 0).toBe(1);
});
