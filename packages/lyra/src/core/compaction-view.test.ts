import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import {
	decodeEntry,
	encodeEntry,
	type CompactionEntry,
	type RecordEntry,
} from "../record/entries.js";
import { loadRecord } from "../record/load.js";
import { fakeClock, scriptedModel, type ScriptedTurn } from "../testkit/index.js";
import { renderPage, timelineTestRecipe, type TimelineState } from "../testkit/timeline-recipe.js";
import { buildView, chooseCut, summaryMaterial } from "./compaction.js";
import { runTask } from "./run.js";
import { replayState } from "./state.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/context-size.md`, "The rows compaction is built against". */

let nextId = 0;

function id(): string {
	nextId += 1;
	return `x${nextId}`;
}

function user(text: string): RecordEntry {
	return { type: "user_message", id: id(), parent: null, ts: 1, label: "task", text };
}

function assistant(text: string, callIds: string[]): RecordEntry {
	return {
		type: "assistant_message",
		id: id(),
		parent: null,
		ts: 1,
		text,
		toolCalls: callIds.map((callId) => ({ id: callId, name: "read", arguments: "{}" })),
		model: "generated/model",
		usage: { inputTokens: 0, outputTokens: 0 },
		finishReason: callIds.length > 0 ? "tool_calls" : "stop",
	};
}

function result(callId: string, content: string): RecordEntry {
	return {
		type: "tool_message",
		id: id(),
		parent: null,
		ts: 1,
		toolCallId: callId,
		isError: false,
		content,
	};
}

function compaction(
	firstKept: string,
	summary: string,
	trigger: "auto" | "manual" = "auto",
): CompactionEntry {
	return {
		type: "compaction",
		id: id(),
		parent: null,
		ts: 1,
		summary,
		firstKept,
		replaces: 3,
		usage: { inputTokens: 100, outputTokens: 20 },
		model: "generated/model",
		trigger,
		instructionsHash: "abc123",
	};
}

/** The messages as a short shape, so a test reads as the order it names. */
function shape(entries: readonly RecordEntry[]): string[] {
	return entries.map((entry) => {
		switch (entry.type) {
			case "user_message":
				return `user:${entry.text.split("\n")[0]}`;
			case "assistant_message":
				return `assistant:${entry.text}`;
			case "tool_message":
				return `tool:${entry.content}`;
			case "compaction":
				return `compaction:${entry.summary}`;
			default:
				return entry.type;
		}
	});
}

test("CMP06 the view is the summary, then the state, then the entries after the pointer", () => {
	const task = user("the job");
	const first = assistant("starting", ["c1"]);
	const firstResult = result("c1", "the first answer");
	const next = assistant("carrying on", []);
	const later = assistant("and later", []);
	// The compaction is written at the gap after the work it keeps, pointing at the
	// first entry the model still sees.
	const short = compaction(next.id, "the summary so far");

	const path = [task, first, firstResult, next, later, short];
	const view = buildView(path, ["Current state of page: ## lattice\n- one line"]);

	expect(view.summary).toBe("the summary so far");
	// Only what came after the pointer is kept verbatim, and it is in order.
	expect(view.entries).toEqual([next, later]);
	expect(shape(view.entries)).toEqual(["assistant:carrying on", "assistant:and later"]);

	// The conversation is the summary, then each tool's state, then the suffix.
	const messages = view.messages;
	expect(messages[0]?.role).toBe("user");
	expect(messages[0]?.role === "user" ? messages[0].text : "").toContain("the summary so far");
	expect(messages[1]).toEqual({
		role: "user",
		text: "Current state of page: ## lattice\n- one line",
	});
	expect(messages.slice(2)).toEqual([
		{ role: "assistant", text: "carrying on", toolCalls: [] },
		{ role: "assistant", text: "and later", toolCalls: [] },
	]);
	// The instructions are never among the messages: the system text is its own field.
	expect(messages.every((message) => message.role !== "assistant" || message.text !== "")).toBe(
		true,
	);
});

test("CMP06 a record with no compaction is the whole conversation, unchanged", () => {
	const task = user("the job");
	const said = assistant("done", []);
	const view = buildView([task, said]);
	expect(view.summary).toBeUndefined();
	expect(view.messages).toEqual([
		{ role: "user", text: "the job" },
		{ role: "assistant", text: "done", toolCalls: [] },
	]);
});

/** The timeline's day, as the resume test in the testkit uses it. */
const DAY = {
	repos: ["lattice", "lyra"],
	commits: [
		{ repo: "lattice", sha: "abc123", message: "Fix the thing" },
		{ repo: "lyra", sha: "def456", message: "Write the docs" },
	],
};

const turns: ScriptedTurn[] = [
	{ toolCalls: [{ id: "t1", name: "start_project", args: { repo: "lattice" } }] },
	{
		toolCalls: [
			{
				id: "t2",
				name: "add_line",
				args: { project: "lattice", text: "Fixed the thing", cites: ["c1"] },
			},
		],
	},
	{ toolCalls: [{ id: "t3", name: "start_project", args: { repo: "lyra" } }] },
	{
		toolCalls: [
			{
				id: "t4",
				name: "add_line",
				args: { project: "lyra", text: "Wrote the docs", cites: ["c2"] },
			},
		],
	},
	{ toolCalls: [{ id: "t5", name: "finish", args: {} }] },
];

const PAGE = [
	"## lattice",
	"- l1 Fixed the thing [c1]",
	"## lyra",
	"- l2 Wrote the docs [c2]",
].join("\n");

test("CMP07 replaying the full record rebuilds the state exactly after a compaction", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	const setup = timelineTestRecipe.setup;
	if (setup === undefined) {
		throw new Error("the test recipe has no setup");
	}
	const result = await runTask({
		runId: "run-1",
		task: "timeline-test",
		host: "test-host",
		input: "",
		inputValue: DAY,
		setup,
		system: timelineTestRecipe.instructions,
		tools: [...timelineTestRecipe.tools],
		model: scriptedModel(turns, { clock }),
		storage,
		clock,
		ids: counterIds(),
	});
	expect(result.reason).toBe("done");
	expect(renderPage(result.state as TimelineState)).toBe(PAGE);

	const read = await storage.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	const entries = loaded.ok ? loaded.value.entries : [];

	// The compaction was written after the work it summarizes, pointing at the
	// first entry the model would still see.
	const written: CompactionEntry = {
		...compaction((entries[4] as RecordEntry).id, "the day so far"),
		parent: (entries.at(-1) as RecordEntry).id,
	};
	const tools = new Map<string, Tool>(
		timelineTestRecipe.tools.map((tool) => [tool.spec.name, tool]),
	);

	// Replay walks every tool message, including the ones the summary stands in
	// for, so the page comes back exactly as the live run had it.
	const rebuilt = replayState(setup(DAY).state, [...entries, written], tools);
	expect(renderPage(rebuilt)).toBe(renderPage(result.state as TimelineState));
	expect(renderPage(rebuilt)).toBe(PAGE);

	// The view is short even though the record is not: that is the whole point.
	const view = buildView([...entries, written]);
	expect(view.messages.length).toBeLessThan(entries.length);
	expect(view.summary).toBe("the day so far");
});

test("CMP08 a second compaction updates the first instead of starting again", () => {
	const task = user("the job");
	const first = assistant("one", ["c1"]);
	const firstResult = result("c1", "answer one");
	// The first compaction kept the second step and everything after it.
	const second = assistant("two", ["c2"]);
	const secondResult = result("c2", "answer two");
	const firstSummary = compaction(second.id, "the first summary");

	// The steps the second compaction will see.
	const third = assistant("three", ["c3"]);
	const thirdResult = result("c3", "answer three");

	const before = buildView([task, first, firstResult, second, secondResult, firstSummary, third]);
	expect(before.summary).toBe("the first summary");

	// What the second summary is written from: the first summary, and the steps it
	// never saw, oldest first.
	const cut = chooseCut(before.entries, 0);
	expect(cut?.firstKept).toBe(third.id);
	const material = summaryMaterial(before, cut as NonNullable<typeof cut>);
	expect(material).toContain("The previous summary, which you are updating");
	expect(material).toContain("the first summary");
	// What the first summary already covers is not sent again: that is what makes
	// a second compaction a summary of a summary rather than a start over.
	expect(material).not.toContain("answer one");
	expect(material).toContain("two");
	expect(material).toContain("answer two");
	// The step being kept verbatim is not summarized again.
	expect(material).not.toContain("three");

	// Once the second compaction is saved, the view shows only the newest summary
	// and the entries after its pointer.
	const secondSummary = compaction(third.id, "the second summary");
	const after = buildView([
		task,
		first,
		firstResult,
		second,
		secondResult,
		firstSummary,
		third,
		thirdResult,
		secondSummary,
	]);
	expect(after.summary).toBe("the second summary");
	expect(after.entries).toEqual([third, thirdResult]);
	const shown = after.messages[0];
	expect(shown?.role === "user" ? shown.text : "").not.toContain("the first summary");
});

test("CMP09 a compaction entry carrying a field this build does not know still loads", () => {
	const line = JSON.stringify({
		type: "compaction",
		id: "e9",
		parent: "e8",
		ts: 5,
		summary: "the summary",
		firstKept: "e4",
		replaces: 4,
		usage: { inputTokens: 10, outputTokens: 2 },
		model: "some/model",
		trigger: "auto",
		instructionsHash: "abc123",
		// A newer Lyra's own field: it must not cost the record the entry.
		futureField: { nested: [1, 2, 3] },
	});

	const decoded = decodeEntry(JSON.parse(line), line);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}
	expect(decoded.value).toMatchObject({
		type: "compaction",
		summary: "the summary",
		firstKept: "e4",
		replaces: 4,
		model: "some/model",
		trigger: "auto",
		instructionsHash: "abc123",
	});
	// The field is dropped on the way back out rather than carried along unread.
	expect(encodeEntry(decoded.value)).not.toContain("futureField");
});
