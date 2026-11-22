import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import type { RecordEntry } from "../record/entries.js";
import { replayConversation } from "../record/replay.js";
import {
	createFinishTool,
	crashingStorage,
	fakeClock,
	scriptedModel,
	toolReturning,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { timelineTestRecipe, renderPage, type TimelineState } from "../testkit/timeline-recipe.js";
import { until } from "./run-harness.testing.js";
import type { StorageSlot } from "./slots.js";
import { runTask, type RunConfig } from "./run.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/context-size.md`, "The rows compaction is built against". */

const RESERVE = 100;
const KEEP = 100;
const WINDOW = 600;

function call(id: string, name: string, inputTokens: number): ScriptedTurn {
	return {
		toolCalls: [{ id, name, args: {} }],
		usage: { inputTokens, outputTokens: 0 },
	};
}

/** A run whose reported input tokens pass the threshold before its fourth turn. */
const TURNS: ScriptedTurn[] = [
	call("c1", "read", 200),
	call("c2", "look", 300),
	call("c3", "read", 400),
	call("c4", "look", 150),
	call("c5", "finish", 200),
];

const SUMMARIES: ScriptedTurn[] = [
	{ text: "the run so far" },
	{ text: "the run so far, again" },
	{ text: "the run so far, once more" },
];

function makeTools(content = "x".repeat(400)): Tool[] {
	// Safe to repeat, so a kill between a call and its result is answered by
	// running it again: this row is about the cut, not about what may be repeated.
	return [
		toolReturning("read", content, { safeToRepeat: true }),
		toolReturning("look", content, { safeToRepeat: true }),
		// A finish is safe to repeat because its check is pure: a kill between the
		// call and its result leaves nothing a second run could duplicate.
		{ ...createFinishTool(), safeToRepeat: true },
	];
}

function base(clock: FakeClock, storage: StorageSlot): Omit<RunConfig, "model" | "resume"> {
	return {
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: makeTools(),
		storage,
		clock,
		ids: counterIds(),
		compaction: { contextWindow: WINDOW, reserveTokens: RESERVE, keepTokens: KEEP },
	};
}

function model(clock: FakeClock, startTurn = 0, summaries: readonly ScriptedTurn[] = SUMMARIES) {
	return scriptedModel(TURNS, { clock, position: "sequence", startTurn, summaries });
}

/**
 * A record reduced to what a caller can see, with the two differences a resume is
 * allowed to make taken out: the `resumed` status, and an unanswered call answered
 * as an unknown outcome.
 */
function projection(entries: readonly RecordEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "status":
				continue;
			case "user_message":
				lines.push(`user ${entry.label} ${entry.text}`);
				break;
			case "assistant_message":
				lines.push(
					`assistant ${entry.text} ${entry.toolCalls
						.map((each) => `${each.id}/${each.name}`)
						.join(",")} ${entry.finishReason}`,
				);
				break;
			case "tool_message":
				if (entry.content.startsWith("outcome unknown:")) {
					continue;
				}
				lines.push(`tool ${entry.toolCallId} ${entry.isError} ${entry.done === true}`);
				break;
			case "compaction":
				lines.push(`compaction ${entry.summary} ${entry.replaces} ${entry.trigger}`);
				break;
			default:
				lines.push(entry.type);
		}
	}
	return lines;
}

function entriesOf(lines: string[]): RecordEntry[] {
	const loaded = loadRecord(lines);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		throw new Error(`the record did not load: ${loaded.error.message}`);
	}
	return loaded.value.entries;
}

test("CMP20 a summary over the entry cap is saved truncated, and the run goes on", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	// A summary far longer than one entry may hold, which is a model answering at
	// any length rather than a case that cannot happen.
	const long = { text: "s".repeat(4_000) };
	const scripted = model(clock, 0, [long]);
	const result = await runTask({
		...base(clock, storage),
		entryCapBytes: 1_000,
		model: scripted,
	});
	expect(result.reason).toBe("done");

	const read = await storage.read();
	expect(read.ok).toBe(true);
	const entries = entriesOf(read.ok ? read.value : []);
	const compaction = entries.find((entry) => entry.type === "compaction");
	if (compaction?.type !== "compaction") {
		throw new Error("the run never compacted");
	}
	expect(compaction.truncated?.field).toBe("summary");
	expect(compaction.truncated?.droppedBytes ?? 0).toBeGreaterThan(0);
	expect(compaction.summary).toContain("[truncated:");

	// The model's view after the cut is the summary the record holds, not the
	// longer one it wrote: a resume would otherwise replay less than the run saw.
	const after = scripted.requests.filter((request) => request.purpose === undefined).at(3)
		?.messages[0];
	const shown = after?.role === "user" ? after.text : "";
	expect(shown).toContain("[truncated:");
	expect(shown.length).toBeLessThan(4_000);
	expect(shown.endsWith(compaction.summary)).toBe(true);
});

test("CMP21 property: killed at every append of a compacting run, the resume matches the whole run", async () => {
	// The uninterrupted run, to know what a resumed one has to match.
	const whole = fakeClock();
	const wholeStorage = memoryStorage();
	const uninterrupted = await runTask({
		...base(whole, wholeStorage),
		model: model(whole),
	});
	expect(uninterrupted.reason).toBe("done");
	const readWhole = await wholeStorage.read();
	expect(readWhole.ok).toBe(true);
	const wholeLines = readWhole.ok ? readWhole.value : [];
	const wholeEntries = entriesOf(wholeLines);
	expect(wholeEntries.filter((entry) => entry.type === "compaction").length).toBeGreaterThan(0);
	const expected = projection(wholeEntries);
	const conversation = JSON.stringify(replayConversation(wholeEntries));

	for (let at = 2; at <= wholeLines.length; at += 1) {
		for (const when of ["before", "after"] as const) {
			const clock = fakeClock();
			const inner = memoryStorage();
			const dying = crashingStorage(inner, { at, when });
			void runTask({ ...base(clock, dying), model: model(clock) });
			await until(() => dying.appends() >= at);
			// Let anything already scheduled settle, so this is what the kill left.
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
			const killed = await inner.read();
			expect(killed.ok).toBe(true);
			const lines = killed.ok ? killed.value : [];

			// A restarted host counts its turns from the record, so the script picks
			// up where the kill left it rather than replaying a turn.
			const turnsTaken = entriesOf(lines).filter(
				(entry) => entry.type === "assistant_message",
			).length;
			const resumed = await runTask({
				...base(clock, inner),
				model: model(clock, turnsTaken),
				resume: { lines, by: "person" },
			});
			expect({ at, when, reason: resumed.reason }).toEqual({ at, when, reason: "done" });

			const after = await inner.read();
			expect(after.ok).toBe(true);
			const entries = entriesOf(after.ok ? after.value : []);
			expect({ at, when, record: projection(entries) }).toEqual({
				at,
				when,
				record: expected,
			});
			// The full record still rebuilds the same conversation for the model.
			expect({ at, when, conversation: JSON.stringify(replayConversation(entries)) }).toEqual(
				{ at, when, conversation },
			);
			// Every tool result is still in the record, whatever the summary folded.
			expect(entries.filter((entry) => entry.type === "tool_message").length).toBe(
				wholeEntries.filter((entry) => entry.type === "tool_message").length,
			);
		}
	}
	expect({ at: "all", when: "all" }).toEqual({ at: "all", when: "all" });
	expect(projection(wholeEntries)).toEqual(expected);
});

const LONG_DAY = {
	repos: ["lattice", "lyra", "lumen"],
	commits: [
		{ repo: "lattice", sha: "a1", message: "Fix the thing" },
		{ repo: "lattice", sha: "a2", message: "Write the test" },
		{ repo: "lyra", sha: "b1", message: "Build the loop" },
		{ repo: "lyra", sha: "b2", message: "Build the record" },
		{ repo: "lumen", sha: "c1", message: "Shape the slot" },
		{ repo: "lumen", sha: "c2", message: "Shape the host" },
	],
};

/**
 * Reported input tokens climb to just under the window and then stay there: a
 * provider never reports more than the window, because that request would not
 * have been sent, and a number over it would make the run fail `input_too_large`.
 */
const LONG_TURNS: ScriptedTurn[] = [
	{
		toolCalls: [{ id: "t1", name: "start_project", args: { repo: "lattice" } }],
		usage: { inputTokens: 200, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t2",
				name: "add_line",
				args: { project: "lattice", text: "Fixed it", cites: ["c1"] },
			},
		],
		usage: { inputTokens: 300, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t3",
				name: "add_line",
				args: { project: "lattice", text: "Tested it", cites: ["c2"] },
			},
		],
		usage: { inputTokens: 400, outputTokens: 0 },
	},
	{
		toolCalls: [{ id: "t4", name: "start_project", args: { repo: "lyra" } }],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t5",
				name: "add_line",
				args: { project: "lyra", text: "Built the loop", cites: ["c3"] },
			},
		],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t6",
				name: "add_line",
				args: { project: "lyra", text: "Built the record", cites: ["c4"] },
			},
		],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [{ id: "t7", name: "start_project", args: { repo: "lumen" } }],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t8",
				name: "add_line",
				args: { project: "lumen", text: "Shaped the slot", cites: ["c5"] },
			},
		],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [
			{
				id: "t9",
				name: "add_line",
				args: { project: "lumen", text: "Shaped the host", cites: ["c6"] },
			},
		],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [
			{ id: "t10", name: "add_vine", args: { line: "l1", text: "and the loop works" } },
		],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
	{
		toolCalls: [{ id: "t11", name: "finish", args: {} }],
		usage: { inputTokens: 550, outputTokens: 0 },
	},
];

test("CMP22 a long run compacts several times and builds the same page as one that never did", async () => {
	const setup = timelineTestRecipe.setup;
	if (setup === undefined) {
		throw new Error("the test recipe has no setup");
	}
	const summaries: ScriptedTurn[] = Array.from({ length: LONG_TURNS.length }, (_, index) => ({
		text: `summary ${index + 1}`,
	}));

	const runOf = async (compact: boolean) => {
		const clock = fakeClock();
		const storage = memoryStorage();
		const scripted = scriptedModel(LONG_TURNS, {
			clock,
			position: "sequence",
			summaries,
		});
		const result = await runTask({
			runId: "run-1",
			task: "timeline-test",
			host: "test-host",
			input: "",
			inputValue: LONG_DAY,
			setup,
			system: timelineTestRecipe.instructions,
			tools: [...timelineTestRecipe.tools],
			model: scripted,
			storage,
			clock,
			ids: counterIds(),
			...(compact
				? { compaction: { contextWindow: WINDOW, reserveTokens: RESERVE, keepTokens: 1 } }
				: {}),
		});
		const read = await storage.read();
		expect(read.ok).toBe(true);
		return { result, entries: entriesOf(read.ok ? read.value : []), model: scripted };
	};

	const compacting = await runOf(true);
	const plain = await runOf(false);

	expect(compacting.result.reason).toBe("done");
	expect(plain.result.reason).toBe("done");
	expect(renderPage(compacting.result.state as TimelineState)).toBe(
		renderPage(plain.result.state as TimelineState),
	);

	// It really compacted several times, and the record kept every turn anyway.
	const compactions = compacting.entries.filter((entry) => entry.type === "compaction");
	expect(compactions.length).toBeGreaterThan(2);
	expect(compacting.entries.filter((entry) => entry.type === "assistant_message")).toHaveLength(
		plain.entries.filter((entry) => entry.type === "assistant_message").length,
	);
	expect(compacting.entries.filter((entry) => entry.type === "tool_message")).toHaveLength(
		plain.entries.filter((entry) => entry.type === "tool_message").length,
	);

	// Every summary after the first one updated the one before it rather than
	// starting again, which is what decision 40 asks for.
	const requests = compacting.model.requests.filter(
		(request) => request.purpose === "compaction",
	);
	expect(requests.length).toBe(compactions.length);
	for (const [index, request] of requests.entries()) {
		const first = request.messages[0];
		const text = first?.role === "user" ? first.text : "";
		if (index === 0) {
			expect(text).not.toContain("The previous summary");
		} else {
			expect(text).toContain(
				`The previous summary, which you are updating rather than replacing:\nsummary ${index}`,
			);
		}
	}
});
