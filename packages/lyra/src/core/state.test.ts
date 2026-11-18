import fc from "fast-check";
import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import {
	crashingStorage,
	createFinishTool,
	fakeClock,
	scriptedModel,
	type ScriptedTurn,
} from "../testkit/index.js";
import { isPlainObject } from "./json.js";
import { readResumeSeed } from "./resume.js";
import { runHarness, until } from "./run-harness.testing.js";
import { runTask } from "./run.js";
import { replayState } from "./state.js";
import { defineTool, type Tool, type ToolOutcome } from "./tool.js";
import type { TaskStart } from "./run.js";

/** The rows are in `docs/recipes-and-tools.md`, TOL07 to TOL12. */

interface Page {
	lines: string[];
	/** Call keys already applied, which is how a recipe makes a repeat harmless. */
	seen: string[];
}

/** A fresh start each time: a tool that mutates the state must not poison the next test. */
const firstRun = (): TaskStart => ({
	message: "build the page",
	state: { lines: [], seen: [] },
});

const lineSchema = {
	type: "object",
	properties: { text: { type: "string" } },
	required: ["text"],
} as const;

/** The key and the text a line's outcome carries, checked rather than cast. */
function lineOf(outcome: ToolOutcome): { key: string; text: string } {
	const details = outcome.details;
	if (
		!isPlainObject(details) ||
		typeof details["key"] !== "string" ||
		typeof details["text"] !== "string"
	) {
		throw new Error("the tool's details are not a key and a text");
	}
	return { key: details["key"], text: details["text"] };
}

function addLine(executions: string[] = []): Tool {
	return defineTool({
		name: "add_line",
		description: "Add a line to the page.",
		parameters: lineSchema,
		safeToRepeat: true,
		async execute(args, ctx) {
			executions.push(ctx.callId);
			return {
				isError: false,
				content: `added ${args.text}`,
				details: { key: ctx.callKey, text: args.text },
			};
		},
		apply(state: Page, _args, outcome) {
			const line = lineOf(outcome);
			if (state.seen.includes(line.key)) {
				return state;
			}
			return {
				lines: [...state.lines, line.text],
				seen: [...state.seen, line.key],
			};
		},
	});
}

test("TOL07 a successful call changes the state through apply, and a failed one does not", async () => {
	const boom = defineTool({
		name: "boom",
		description: "Fail, and try to change the page anyway.",
		parameters: { type: "object", properties: {} } as const,
		async execute() {
			return { isError: true, content: "it broke" };
		},
		apply(state: Page) {
			return { ...state, lines: [...state.lines, "should not be here"] };
		},
	});
	const harness = runHarness(
		[
			{ toolCalls: [{ id: "c1", name: "add_line", args: { text: "a line" } }] },
			{ toolCalls: [{ id: "c2", name: "boom", args: {} }] },
			{ toolCalls: [{ id: "c3", name: "finish", args: {} }] },
		],
		() => [addLine(), boom, createFinishTool()],
	);

	const result = await harness.run({ setup: firstRun, inputValue: "day" });
	expect(result.reason).toBe("done");
	expect((result.state as Page).lines).toEqual(["a line"]);
});

test("TOL08 for any sequence of calls, the live state equals the replayed one", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.string({ maxLength: 20 }), { maxLength: 4 }),
			async (texts) => {
				const turns: ScriptedTurn[] = texts.map((text, index) => ({
					toolCalls: [{ id: `c${index}`, name: "add_line", args: { text } }],
				}));
				turns.push({ toolCalls: [{ id: "cfin", name: "finish", args: {} }] });
				const tools = [addLine(), createFinishTool()];
				const harness = runHarness(turns, () => tools);
				const result = await harness.run({ setup: firstRun, inputValue: "day" });
				expect(result.reason).toBe("done");

				const saved = await harness.storage.read();
				expect(saved.ok).toBe(true);
				if (!saved.ok) {
					return;
				}
				const seed = readResumeSeed(saved.value);
				if (!seed.ok) {
					throw new Error(seed.error.message);
				}
				const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
				const replayed = replayState(firstRun().state, seed.value.record.entries, byName);
				expect(replayed).toEqual(result.state);
			},
		),
		{ numRuns: 20 },
	);
});

test("TOL09 a tool that changes state inside execute makes replay differ", async () => {
	const cheater = defineTool({
		name: "cheat",
		description: "Change the page from execute, which is not allowed.",
		parameters: { type: "object", properties: {} } as const,
		async execute(_args, ctx) {
			// Deliberately wrong: this is the mistake the rule's test has to catch.
			(ctx.state as Page).lines.push("changed in execute");
			return { isError: false, content: "done" };
		},
		apply(state: Page) {
			return { ...state, lines: [...state.lines, "changed in apply"] };
		},
	});
	const tools = [cheater, createFinishTool()];
	const harness = runHarness(
		[
			{ toolCalls: [{ id: "c1", name: "cheat", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
		() => tools,
	);

	const result = await harness.run({ setup: firstRun, inputValue: "day" });
	const live = result.state as Page;
	expect(live.lines).toEqual(["changed in execute", "changed in apply"]);

	const saved = await harness.storage.read();
	if (!saved.ok) {
		throw new Error("the record could not be read");
	}
	const seed = readResumeSeed(saved.value);
	if (!seed.ok) {
		throw new Error(seed.error.message);
	}
	const byName = new Map(tools.map((tool) => [tool.spec.name, tool]));
	const replayed = replayState(firstRun().state, seed.value.record.entries, byName) as Page;
	expect(replayed.lines).toEqual(["changed in apply"]);
	expect(replayed).not.toEqual(live);
});

test("TOL10 applying the same call key twice changes nothing", () => {
	const tool = addLine();
	const outcome: ToolOutcome = {
		isError: false,
		content: "added a line",
		details: { key: "run-1:c1", text: "a line" },
	};
	const args = { text: "a line" };
	const once = tool.apply?.(firstRun().state, args, outcome) as Page;
	const twice = tool.apply?.(once, args, outcome) as Page;

	expect(once.lines).toEqual(["a line"]);
	expect(twice).toEqual(once);
});

test("TOL11 a resume replays a saved result without running the tool again", async () => {
	const executions: string[] = [];
	const tools = [addLine(executions), createFinishTool()];
	const clock = fakeClock();
	const inner = memoryStorage();
	const turns = [
		{ toolCalls: [{ id: "c1", name: "add_line", args: { text: "a line" } }] },
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const setup = firstRun;
	const config = {
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "build the page",
		inputValue: "day" as const,
		system: "you are a test",
		tools,
		clock,
		ids: counterIds(),
		setup,
	};

	// Die once the first tool result is saved, which is after the tool ran.
	const dying = crashingStorage(inner, { at: 5, when: "after" });
	void runTask({
		...config,
		model: scriptedModel(turns, { clock }),
		storage: dying,
	});
	await until(() => dying.appends() >= 5);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const read = await inner.read();
	expect(read.ok).toBe(true);
	const lines = read.ok ? read.value : [];

	const resumed = await runTask({
		...config,
		model: scriptedModel(turns, { clock }),
		storage: inner,
		resume: { lines, by: "person" },
	});

	expect(resumed.reason).toBe("done");
	expect(executions).toEqual(["c1"]);
	expect((resumed.state as Page).lines).toEqual(["a line"]);
});

test("TOL12 a task input too big for one entry is refused before anything is saved", async () => {
	const harness = runHarness([], () => [addLine(), createFinishTool()]);
	const result = await harness.run({
		setup: firstRun,
		inputValue: "x".repeat(2 * 1024 * 1024),
	});

	expect(result.reason).toBe("failed");
	expect(result.error?.code).toBe("bad_request");
	const record = await harness.storage.read();
	expect(record.ok && record.value).toEqual([]);
});
