import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import {
	createFinishTool as testkitFinish,
	fakeClock,
	scriptedModel,
	toolReturning,
} from "../testkit/index.js";
import type { RecordEntry } from "../record/entries.js";
import { defineRecipe, RecipeDefinitionError } from "./define-recipe.js";
import { createFinishTool } from "./finish.js";
import { pinRecipe } from "./recipe.js";
import { createRuntime } from "./runtime.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/recipes-and-tools.md`, RCP01 to RCP06. */

const daySchema = {
	type: "object",
	properties: { day: { type: "string" } },
	required: ["day"],
} as const;

function timelineRecipe() {
	return defineRecipe({
		name: "timeline-test",
		version: 1,
		instructions: "build the page",
		input: daySchema,
		setup: (input) => ({
			message: `build the page for ${input.day}`,
			state: { day: input.day },
		}),
		tools: [
			createFinishTool<{ day: string }>({ check: () => ({ ok: true }) }),
			toolReturning("read", "the content"),
		],
		limits: { steps: 4 },
		fallbackModel: "the-fallback",
		stuck: { reminders: 1 },
	});
}

test("RCP01 a valid recipe keeps its instructions, tools, limits and pin", async () => {
	const recipe = timelineRecipe();
	expect(recipe.name).toBe("timeline-test");
	expect(recipe.version).toBe(1);
	expect(recipe.instructions).toBe("build the page");
	expect(recipe.limits).toEqual({ steps: 4 });
	expect(recipe.fallbackModel).toBe("the-fallback");
	expect(recipe.stuck).toEqual({ reminders: 1 });
	expect(recipe.tools.map((tool) => tool.spec.name)).toEqual(["finish", "read"]);

	const pin = await pinRecipe({
		name: recipe.name,
		version: recipe.version,
		instructions: recipe.instructions,
		tools: recipe.tools.map((tool) => tool.spec),
	});
	expect(pin.tools?.map((tool) => tool.name)).toEqual(["finish", "read"]);
	expect(recipe.setup?.({ day: "Monday" })).toEqual({
		message: "build the page for Monday",
		state: { day: "Monday" },
	});
});

test("RCP02 two tools with one name are refused when the recipe is defined", () => {
	expect(() =>
		defineRecipe({
			name: "duplicated",
			version: 1,
			instructions: "do it",
			input: daySchema,
			setup: (input) => ({ message: input.day, state: undefined }),
			tools: [toolReturning("read", "a"), toolReturning("read", "b")],
		}),
	).toThrow(/"read"/);
});

test("RCP03 a tool whose schema cannot be compiled is refused, naming it", () => {
	const broken: Tool = {
		spec: {
			name: "search",
			description: "a tool with a regular expression",
			parameters: { type: "object", properties: { q: { type: "string", pattern: "^a" } } },
		},
		execute: async () => ({ isError: false, content: "never" }),
	};
	expect(() =>
		defineRecipe({
			name: "broken",
			version: 1,
			instructions: "do it",
			input: daySchema,
			setup: (input) => ({ message: input.day, state: undefined }),
			tools: [broken],
		}),
	).toThrow(/search.*pattern/);
});

test("RCP04 a tool called finish without a done-check is refused", () => {
	expect(() =>
		defineRecipe({
			name: "unchcked",
			version: 1,
			instructions: "do it",
			input: daySchema,
			setup: (input) => ({ message: input.day, state: undefined }),
			tools: [toolReturning("finish", "done"), testkitFinish()],
		}),
	).toThrow(RecipeDefinitionError);
	expect(() =>
		defineRecipe({
			name: "unchecked",
			version: 1,
			instructions: "do it",
			input: daySchema,
			setup: (input) => ({ message: input.day, state: undefined }),
			tools: [toolReturning("finish", "done")],
		}),
	).toThrow(/"finish"/);
});

function runtimeFor(recipe: ReturnType<typeof timelineRecipe>) {
	const clock = fakeClock();
	const storage = memoryStorage();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel([{ toolCalls: [{ id: "c1", name: "finish", args: {} }] }], {
			clock,
		}),
		host: "test-host",
	});
	return { clock, storage, runtime, recipe };
}

async function entriesOf(storage: ReturnType<typeof memoryStorage>): Promise<RecordEntry[]> {
	const read = await storage.read();
	if (!read.ok) {
		return [];
	}
	const loaded = loadRecord(read.value);
	return loaded.ok ? loaded.value.entries : [];
}

test("RCP05 an input the recipe's schema refuses is bad_request, and nothing is saved", async () => {
	const { runtime, storage, recipe } = runtimeFor(timelineRecipe());
	const started = runtime.start({
		runId: "run-1",
		task: "timeline-test",
		input: { day: 7 },
		definition: recipe,
	});

	expect(started.ok).toBe(false);
	if (started.ok) {
		return;
	}
	expect(started.error.code).toBe("bad_request");
	expect(started.error.message).toContain("input.day");
	expect(await entriesOf(storage)).toEqual([]);
});

test("RCP06 a good input makes the first message and the state, and is saved with it", async () => {
	const { runtime, storage, recipe } = runtimeFor(timelineRecipe());
	const started = runtime.start({
		runId: "run-1",
		task: "timeline-test",
		input: { day: "Monday" },
		definition: recipe,
	});
	expect(started.ok).toBe(true);
	if (!started.ok) {
		return;
	}
	const outcome = await started.value.outcome;
	expect(outcome.reason).toBe("done");
	expect(outcome.state).toEqual({ day: "Monday" });

	const entries = await entriesOf(storage);
	const task = entries.find((entry) => entry.type === "user_message" && entry.label === "task");
	if (task?.type !== "user_message") {
		throw new Error("the task message was not saved");
	}
	expect(task.text).toBe("build the page for Monday");
	expect(task.details).toEqual({ input: { day: "Monday" } });
});
