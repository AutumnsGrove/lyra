import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import { utf8Length } from "../record/truncate.js";
import { createFinishTool, fakeClock, scriptedModel, toolReturning } from "../testkit/index.js";
import { timelineTestRecipe, type TimelineState } from "../testkit/timeline-recipe.js";
import { defineTool, type Tool } from "./tool.js";
import { runTask } from "./run.js";
import { replayState } from "./state.js";
import type { ScriptedTurn } from "../testkit/index.js";

/** The rows are in `docs/context-size.md`, "The rows compaction is built against". */

const DAY = {
	repos: ["lattice", "lyra"],
	commits: [
		{ repo: "lattice", sha: "abc123", message: "Fix the thing" },
		{ repo: "lyra", sha: "def456", message: "Write the docs" },
	],
};

/** The page after the third turn, which is when the compaction showed it. */
const PAGE_SO_FAR = ["## lattice", "- l1 Fixed the thing [c1]", "## lyra"].join("\n");

function call(id: string, name: string, args: unknown, inputTokens: number): ScriptedTurn {
	return { toolCalls: [{ id, name, args }], usage: { inputTokens, outputTokens: 0 } };
}

async function entriesOf(storage: ReturnType<typeof memoryStorage>) {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : [];
}

test("CMP17 the tool's current state is shown exactly, after the summary", async () => {
	const setup = timelineTestRecipe.setup;
	if (setup === undefined) {
		throw new Error("the test recipe has no setup");
	}
	const clock = fakeClock();
	const storage = memoryStorage();
	const turns: ScriptedTurn[] = [
		call("t1", "start_project", { repo: "lattice" }, 200),
		call("t2", "add_line", { project: "lattice", text: "Fixed the thing", cites: ["c1"] }, 400),
		call("t3", "start_project", { repo: "lyra" }, 550),
		call("t4", "add_line", { project: "lyra", text: "Wrote the docs", cites: ["c2"] }, 150),
		call("t5", "finish", {}, 200),
	];
	const model = scriptedModel(turns, {
		clock,
		position: "sequence",
		summaries: [{ text: "the day so far" }],
	});
	model.contextWindow = 600;

	const result = await runTask({
		runId: "run-1",
		task: "timeline-test",
		host: "test-host",
		input: "",
		inputValue: DAY,
		setup,
		system: timelineTestRecipe.instructions,
		tools: [...timelineTestRecipe.tools],
		model,
		storage,
		clock,
		ids: counterIds(),
		// A small keep budget because the projection's own content is small: the
		// reported input tokens are what makes the trigger fire here.
		compaction: { reserveTokens: 100, keepTokens: 5 },
	});
	expect(result.reason).toBe("done");

	// The fourth request is the first after the compaction, and it is shown the
	// summary, then exactly what the tool says the page is, then the kept step.
	const fourth = model.requests.filter((request) => request.purpose === undefined)[3];
	expect(fourth?.messages.map((message) => message.role)).toEqual([
		"user",
		"user",
		"assistant",
		"tool",
	]);
	const state = fourth?.messages[1];
	expect(state?.role === "user" ? state.text : "").toBe(
		`Current state of start_project:\n${PAGE_SO_FAR}`,
	);
	expect(result.state).toMatchObject({
		page: {
			projects: [{ repo: "lattice", lines: [{ id: "l1" }] }, { repo: "lyra" }],
		},
	});

	// A record with no compaction shows no state text: it is for a cut view only.
	const first = model.requests.filter((request) => request.purpose === undefined)[0];
	expect(first?.messages).toHaveLength(1);

	// The state text is never stored: it is rebuilt from the record when needed.
	const entries = await entriesOf(storage);
	expect(entries.some((entry) => JSON.stringify(entry).includes(PAGE_SO_FAR))).toBe(false);
	expect((result.state as TimelineState).page.projects).toHaveLength(2);
});

test("CMP18 a result over the cap is cut when it arrives, and the record keeps what the model saw", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	const content = "z".repeat(5_000);
	const read = toolReturning("read", content, {
		maxResultBytes: 1_000,
		truncationHint: "call read again with a smaller range",
	});
	const model = scriptedModel(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
		{ clock },
	);
	const events: string[] = [];
	const finished = createFinishTool();
	const result = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "read the thing",
		system: "you are a test",
		tools: [read, finished],
		model,
		storage,
		clock,
		ids: counterIds(),
		onEvent: (event) => {
			if (event.type === "tool_end") {
				events.push(event.content);
			}
		},
	});
	expect(result.reason).toBe("done");

	const entries = await entriesOf(storage);
	const first = entries.find((entry) => entry.type === "tool_message");
	if (first?.type !== "tool_message") {
		throw new Error("the record has no result");
	}
	const dropped = first.truncated?.droppedBytes ?? 0;
	expect(first.truncated?.field).toBe("content");
	expect(dropped).toBeGreaterThan(0);
	expect(new TextEncoder().encode(first.content).length).toBeLessThanOrEqual(1_000);
	expect(first.content).toContain(`[truncated: ${dropped} bytes dropped]`);
	expect(first.content).toContain("call read again with a smaller range");

	// The model was handed exactly the record's text, and so was the event.
	const asked = model.requests.at(-1)?.messages.find((message) => message.role === "tool");
	expect(asked?.role === "tool" ? asked.content : "").toBe(first.content);
	expect(events[0]).toBe(first.content);

	// A cap that means nothing is not a cap: a tool that sets zero falls back to the
	// next one out rather than emptying what the model reads.
	const clockAgain = fakeClock();
	const otherStorage = memoryStorage();
	const pointless = toolReturning("read", "z".repeat(200), { maxResultBytes: 0 });
	const second = await runTask({
		runId: "run-2",
		task: "test-task",
		host: "test-host",
		input: "read the thing",
		system: "you are a test",
		tools: [pointless, createFinishTool()],
		model: scriptedModel(
			[
				{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
				{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
			],
			{ clock: clockAgain },
		),
		storage: otherStorage,
		clock: clockAgain,
		ids: counterIds(),
		toolResultBytes: 50,
	});
	expect(second.reason).toBe("done");
	const third = (await entriesOf(otherStorage)).find(
		(entry) => entry.type === "tool_message" && entry.toolCallId === "c1",
	);
	if (third?.type !== "tool_message") {
		throw new Error("the two-hundred-byte result is not in the record");
	}
	// The recipe's cap applied, not the tool's zero.
	expect(third.content.length).toBeGreaterThan(0);
	expect(utf8Length(third.content)).toBeLessThanOrEqual(50);
});

test("CMP19 a tool whose state needs the cut part keeps it in details, so replay rebuilds it", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	// The result is deliberately more than the model may read, and everything the
	// state needs travels in `details`, which is for people and never cut to fit
	// the model's view.
	const append = defineTool({
		name: "append",
		description: "Append a line to the document.",
		parameters: {
			type: "object",
			properties: { text: { type: "string", minLength: 1 } },
			required: ["text"],
		},
		maxResultBytes: 120,
		truncationHint: "the line was appended; call nothing to read it back",
		async execute(args) {
			return {
				isError: false,
				content: `appended: ${args.text}\n` + "x".repeat(500),
				details: { text: args.text },
			};
		},
		apply(state: string[], args) {
			return [...state, args.text];
		},
	});
	const tools: Tool[] = [append, createFinishTool()];
	const model = scriptedModel(
		[
			{ toolCalls: [{ id: "c1", name: "append", args: { text: "first line" } }] },
			{ toolCalls: [{ id: "c2", name: "append", args: { text: "second line" } }] },
			{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
		],
		{ clock },
	);
	const result = await runTask({
		runId: "run-1",
		task: "append-test",
		host: "test-host",
		input: "",
		setup: () => ({ message: "append two lines", state: [] as string[] }),
		system: "you are a test",
		tools,
		model,
		storage,
		clock,
		ids: counterIds(),
	});
	expect(result.reason).toBe("done");

	// The cap really fired, which is what makes the replay below worth checking.
	const entries = await entriesOf(storage);
	const results = entries.filter(
		(entry) => entry.type === "tool_message" && entry.toolCallId !== "c3",
	);
	expect(results).toHaveLength(2);
	expect(results.every((entry) => entry.type === "tool_message" && entry.truncated)).toBe(true);

	const replayed = replayState([], entries, new Map(tools.map((tool) => [tool.spec.name, tool])));
	expect(replayed).toEqual(result.state);
	expect(replayed).toEqual(["first line", "second line"]);
});
