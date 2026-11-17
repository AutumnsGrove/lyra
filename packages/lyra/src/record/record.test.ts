import fc from "fast-check";
import { expect, test } from "vitest";

import { encodeEntry, encodeHeader, type RecordEntry, type RecordHeader } from "./entries.js";
import { loadRecord } from "./load.js";
import { entriesArbitrary, headerArbitrary } from "./generators.testing.js";
import { activePath, replayConversation } from "./replay.js";

/** The rows are in `docs/run-record.md`. */

const START = 1_700_000_000_000;

function header(overrides: Partial<RecordHeader> = {}): RecordHeader {
	return {
		type: "header",
		v: 1,
		run: "run-1",
		task: "timeline",
		startedAt: START,
		host: "test",
		...overrides,
	};
}

let nextId = 0;

/** Each entry is built from its parent, so a chain's links are always real. */
function base(parent: RecordEntry | null): { id: string; parent: string | null; ts: number } {
	nextId += 1;
	return { id: `e${nextId}`, parent: parent === null ? null : parent.id, ts: START + nextId };
}

function user(parent: RecordEntry | null, text = "summarize the day"): RecordEntry {
	return { type: "user_message", ...base(parent), label: "task", text };
}

function assistant(parent: RecordEntry | null, calls: [string, string][] = []): RecordEntry {
	return {
		type: "assistant_message",
		...base(parent),
		text: "working",
		toolCalls: calls.map(([id, name]) => ({ id, name, arguments: "{}" })),
		model: "fake/model",
		usage: { inputTokens: 10, outputTokens: 5 },
		finishReason: calls.length > 0 ? "tool_calls" : "stop",
	};
}

function result(parent: RecordEntry, callId: string, isError = false): RecordEntry {
	return { type: "tool_message", ...base(parent), toolCallId: callId, isError, content: "done" };
}

function status(
	parent: RecordEntry | null,
	state: "running" | "parked" | "done" | "failed",
): RecordEntry {
	return { type: "status", ...base(parent), state };
}

test("RCD01 a header and a chain of entries load back equal to what was encoded", () => {
	const head = header({ recipe: { name: "timeline", version: 3, toolSetHash: "abc123" } });
	const first = user(null);
	const second = assistant(first);
	const third = result(second, "c1");
	const fourth = status(third, "done");
	const entries = [first, second, third, fourth];

	const loaded = loadRecord([encodeHeader(head), ...entries.map(encodeEntry)]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.header).toEqual(head);
	expect(loaded.value.entries).toEqual(entries);
	expect(loaded.value.notes).toEqual([]);
});

test("RCD02 replay turns the active path into the conversation, in call order", () => {
	const first = user(null);
	const second = assistant(first, [
		["c1", "read_issue"],
		["c2", "finish"],
	]);
	const third = result(second, "c1");
	// Each result follows the one before it: the record is a straight line, so the
	// second result's parent is the first result, not the assistant message.
	const fourth = result(third, "c2");
	const fifth = status(fourth, "done");

	const loaded = loadRecord(
		[encodeHeader(header()), first, second, third, fourth, fifth].map((line) =>
			typeof line === "string" ? line : encodeEntry(line),
		),
	);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}

	expect(replayConversation(loaded.value.entries)).toEqual([
		{ role: "user", text: "summarize the day" },
		{
			role: "assistant",
			text: "working",
			toolCalls: [
				{ id: "c1", name: "read_issue", arguments: "{}" },
				{ id: "c2", name: "finish", arguments: "{}" },
			],
		},
		{ role: "tool", toolCallId: "c1", content: "done", isError: false },
		{ role: "tool", toolCallId: "c2", content: "done", isError: false },
	]);
});

test("RCD03 a truncated last line is skipped and noted, and the rest loads", () => {
	const first = user(null);
	const loaded = loadRecord([
		encodeHeader(header()),
		encodeEntry(first),
		encodeEntry(assistant(first)).slice(0, 30),
	]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([first]);
	expect(loaded.value.notes).toHaveLength(1);
	expect(loaded.value.notes[0]?.line).toBe(3);
	expect(loaded.value.notes[0]?.problem).toMatch(/JSON/);
});

test("RCD04 a damaged line is noted and skipped, and the good lines around it load", () => {
	const first = user(null);
	const third = assistant(first);
	const loaded = loadRecord([
		encodeHeader(header()),
		encodeEntry(first),
		"}{ not json",
		encodeEntry(third),
		'{"type":"user_message","id":"x","parent":"e1","ts":5}',
	]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([first, third]);
	expect(loaded.value.notes.map((note) => note.line)).toEqual([3, 5]);
});

test("RCD04 a line that is JSON but not an object is noted, not fatal", () => {
	const loaded = loadRecord([encodeHeader(header()), "[1,2,3]", "null", '"a string"']);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([]);
	expect(loaded.value.notes).toHaveLength(3);
});

test("RCD04 an unknown entry kind is preserved with its raw line and skipped by replay", () => {
	const raw = '{"type":"proposal","id":"p1","parent":null,"ts":42,"verdict":"ship"}';
	const loaded = loadRecord([encodeHeader(header()), raw, encodeEntry(user(null))]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	const preserved = loaded.value.entries[0];
	expect(preserved).toEqual({ type: "unknown", id: "p1", parent: null, ts: 42, raw });
	// It is never dropped or rewritten: saving the record again writes the same line.
	expect(preserved === undefined ? "" : encodeEntry(preserved)).toBe(raw);
	expect(loaded.value.notes).toEqual([]);
});

test("RCD04 a duplicate id keeps the first entry and notes the second", () => {
	const first = user(null);
	const duplicate = { ...first, text: "a second entry claiming the same id" };
	const loaded = loadRecord([encodeHeader(header()), encodeEntry(first), encodeEntry(duplicate)]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([first]);
	expect(loaded.value.notes[0]?.line).toBe(3);
	expect(loaded.value.notes[0]?.problem).toMatch(/duplicate/i);
});

test("RCD04 a parent that is not in the record is kept and noted", () => {
	const orphan = { ...user(null), parent: "nope" };
	const loaded = loadRecord([encodeHeader(header()), encodeEntry(orphan)]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([orphan]);
	expect(loaded.value.notes).toHaveLength(1);
	expect(loaded.value.notes[0]?.problem).toMatch(/parent/i);
	// The active path stops where the chain stops, rather than looping or throwing.
	expect(activePath(loaded.value.entries)).toEqual([orphan]);
});

test("RCD04 a parent chain that loops loads, is noted once, and replay terminates", () => {
	const a: RecordEntry = { type: "status", ...base(null), state: "running" };
	const b: RecordEntry = { type: "status", ...base(a), state: "running" };
	const looped = { ...a, parent: b.id };
	const loaded = loadRecord([encodeHeader(header()), encodeEntry(looped), encodeEntry(b)]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.notes.filter((note) => /loop/i.test(note.problem))).toHaveLength(1);
	expect(activePath(loaded.value.entries).length).toBeLessThanOrEqual(2);
});

test("RCD05 a record with no header is refused", () => {
	expect(loadRecord([]).ok).toBe(false);
	expect(loadRecord([encodeEntry(user(null))]).ok).toBe(false);
	expect(loadRecord(["{oops", encodeHeader(header())]).ok).toBe(false);
});

test("RCD05 a header of a version this code does not know is refused", () => {
	const future = loadRecord([JSON.stringify({ ...header(), v: 2 })]);
	expect(future.ok).toBe(false);
	if (!future.ok) {
		expect(future.error.message).toMatch(/version/i);
	}
});

test("RCD06 any valid record survives encode then load, and the active path is the chain", () => {
	fc.assert(
		fc.property(headerArbitrary(), entriesArbitrary(), (head, entries) => {
			const loaded = loadRecord([encodeHeader(head), ...entries.map(encodeEntry)]);
			expect(loaded.ok).toBe(true);
			if (!loaded.ok) {
				return;
			}
			expect(loaded.value.header).toEqual(head);
			expect(loaded.value.entries).toEqual(entries);
			expect(loaded.value.notes).toEqual([]);

			const path = activePath(loaded.value.entries);
			expect(path).toEqual(entries);
			if (path.length > 0) {
				expect(path[0]?.parent).toBeNull();
			}
		}),
		{ numRuns: 200 },
	);
});

test("RCD04 every kind refuses a line of the wrong shape, and the record still loads", () => {
	const head = encodeHeader(header());
	const damaged: unknown[] = [
		// The header itself, field by field.
		{ type: "header", v: 1, run: "", task: "t", startedAt: 1, host: "h" },
		{ type: "header", v: 1, run: "r", startedAt: 1, host: "h" },
		{ type: "header", v: 1, run: "r", task: "t", host: "h" },
		{ type: "header", v: 1, run: "r", task: "t", startedAt: 1 },
		{ type: "header", v: 1, run: "r", task: "t", startedAt: 1, host: "h", recipe: "x" },
		{
			type: "header",
			v: 1,
			run: "r",
			task: "t",
			startedAt: 1,
			host: "h",
			recipe: { name: "n" },
		},
		// Every kind, missing what its own shape needs.
		{ type: "user_message" },
		{ id: "a", parent: null, ts: 1 },
		{ type: "user_message", id: "a", ts: 1 },
		{ type: "user_message", id: "a", parent: null, ts: -1 },
		{ type: "user_message", id: "a", parent: 7, ts: 1 },
		{ type: "user_message", id: "a", parent: null, ts: 1, label: "nudge", text: "x" },
		{ type: "assistant_message", id: "a", parent: null, ts: 1, model: "m" },
		{ type: "assistant_message", id: "a", parent: null, ts: 1, text: "t" },
		{
			type: "assistant_message",
			id: "a",
			parent: null,
			ts: 1,
			text: "t",
			model: "m",
			reasoning: 1,
		},
		{
			type: "assistant_message",
			id: "a",
			parent: null,
			ts: 1,
			text: "t",
			model: "m",
			usage: 1,
		},
		{ type: "tool_message", id: "a", parent: null, ts: 1, isError: false, content: "c" },
		{ type: "tool_message", id: "a", parent: null, ts: 1, toolCallId: "c1", content: "c" },
		{ type: "tool_message", id: "a", parent: null, ts: 1, toolCallId: "c1", isError: false },
		{ type: "status", id: "a", parent: null, ts: 1 },
		{ type: "status", id: "a", parent: null, ts: 1, state: "sleeping" },
		{ type: "status", id: "a", parent: null, ts: 1, state: "done", reason: 5 },
		{ type: "status", id: "a", parent: null, ts: 1, state: "done", reason: "" },
	];

	for (const line of damaged) {
		const loaded = loadRecord([head, JSON.stringify(line)]);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) {
			continue;
		}
		expect(loaded.value.entries).toEqual([]);
		expect(loaded.value.notes).toHaveLength(1);
	}

	// A second header is noted rather than taken as an entry.
	const second = loadRecord([head, head]);
	expect(second.ok).toBe(true);
	if (second.ok) {
		expect(second.value.notes[0]?.problem).toMatch(/second header/);
	}
});

test("RCD04 details that are JSON too deep to trust are refused, not recursed into", () => {
	let deep: unknown = "bottom";
	for (let level = 0; level < 70; level += 1) {
		deep = [deep];
	}
	const line = JSON.stringify({
		type: "tool_message",
		id: "a",
		parent: null,
		ts: 1,
		toolCallId: "c1",
		isError: false,
		content: "done",
		details: deep,
	});
	const loaded = loadRecord([encodeHeader(header()), line]);

	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual([]);
	expect(loaded.value.notes[0]?.problem).toMatch(/details/);
});
