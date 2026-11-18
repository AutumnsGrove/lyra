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
import { createRuntime, type RunDefinition } from "./runtime.js";
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

async function statusesOf(storage: ReturnType<typeof memoryStorage>): Promise<string[]> {
	const entries = await entriesOf(storage);
	return entries.filter((entry) => entry.type === "status").map((entry) => entry.state);
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

test("RCP05 a hand-written definition with an uncompilable input schema is bad_request, not a throw", () => {
	const { runtime, storage } = runtimeFor(timelineRecipe());
	const definition: RunDefinition = {
		name: "hand-written",
		version: 1,
		instructions: "do it",
		input: { type: "object", properties: { day: { type: "string", pattern: "^a" } } },
		tools: [],
	};

	let outcome: ReturnType<typeof runtime.start> | undefined;
	expect(() => {
		outcome = runtime.start({
			runId: "run-1",
			task: "hand-written",
			input: { day: "abc" },
			definition,
		});
	}).not.toThrow();
	expect(outcome?.ok).toBe(false);
	if (outcome !== undefined && !outcome.ok) {
		expect(outcome.error.code).toBe("bad_request");
		expect(outcome.error.message).toContain("pattern");
	}
	return (async () => {
		expect(await entriesOf(storage)).toEqual([]);
	})();
});

test("RCP07 a resume under a changed input schema fails before setup runs", async () => {
	const tools = [
		createFinishTool<{ day: string }>({ check: () => ({ ok: true }) }),
		toolReturning("read", "the content"),
	];
	const first = defineRecipe({
		name: "input-check",
		version: 1,
		instructions: "build the page",
		input: daySchema,
		setup: (input) => ({ message: input.day, state: { day: input.day } }),
		tools,
		limits: { steps: 1 },
	});
	const clock = fakeClock();
	const storage = memoryStorage();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel([{ toolCalls: [{ id: "c1", name: "read", args: {} }] }], { clock }),
		host: "test-host",
	});
	const started = runtime.start({
		runId: "run-1",
		task: "input-check",
		input: { day: "Monday" },
		definition: first,
	});
	expect(started.ok).toBe(true);
	if (!started.ok) {
		return;
	}
	const parked = await started.value.outcome;
	expect(parked.reason).toBe("parked");
	expect(parked.parkedDetail).toBe("steps");

	// The deploy renamed the input field, so the record's input is not this recipe's.
	let setupRan = false;
	const changed = defineRecipe({
		name: "input-check",
		version: 2,
		instructions: "build the page",
		input: { type: "object", properties: { when: { type: "string" } }, required: ["when"] },
		setup: (input) => {
			setupRan = true;
			return { message: input.when.toUpperCase(), state: { when: input.when } };
		},
		tools,
	});
	const resumed = await runtime.resume({
		runId: "run-1",
		task: "input-check",
		definition: changed,
	});
	expect(resumed.ok).toBe(true);
	if (!resumed.ok) {
		return;
	}
	const outcome = await resumed.value.outcome;
	expect(outcome.reason).toBe("failed");
	expect(outcome.error?.message).toContain("no longer matches the recipe's input schema");
	expect(setupRan).toBe(false);
});

test("RCP07 a done record resumed under a changed schema stays done, and a wake leaves a park alone", async () => {
	const tools = [createFinishTool<{ day: string }>({ check: () => ({ ok: true }) })];
	const first = defineRecipe({
		name: "input-check",
		version: 1,
		instructions: "build the page",
		input: daySchema,
		setup: (input) => ({ message: input.day, state: { day: input.day } }),
		tools,
		limits: { steps: 1 },
	});
	const clock = fakeClock();
	const storage = memoryStorage();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(
			[
				{ toolCalls: [{ id: "c1", name: "finish", args: {} }] },
				{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
			],
			{ clock },
		),
		host: "test-host",
	});
	const started = runtime.start({
		runId: "run-1",
		task: "input-check",
		input: { day: "Monday" },
		definition: first,
	});
	if (!started.ok) {
		throw new Error(started.error.message);
	}
	expect((await started.value.outcome).reason).toBe("done");
	const done = await statusesOf(storage);
	expect(done).toEqual(["running", "done"]);

	// The deploy tightened the input schema, so the saved input no longer matches it,
	// but setup would still read the field it knows. A finished record is not rewritten.
	const tightened = defineRecipe({
		name: "input-check",
		version: 2,
		instructions: "build the page",
		input: {
			type: "object",
			properties: { day: { type: "string" }, extra: { type: "string" } },
			required: ["day", "extra"],
		},
		setup: (input) => ({ message: input.day, state: { day: input.day } }),
		tools,
		limits: { steps: 1 },
	});
	const resumed = await runtime.resume({
		runId: "run-1",
		task: "input-check",
		definition: tightened,
	});
	if (!resumed.ok) {
		throw new Error(resumed.error.message);
	}
	expect((await resumed.value.outcome).reason).toBe("done");
	expect(await statusesOf(storage)).toEqual(done);
});

test("RCP07 a wake on a parked run under a changed schema writes nothing", async () => {
	const tools = [toolReturning("read", "the content")];
	const first = defineRecipe({
		name: "input-check",
		version: 1,
		instructions: "build the page",
		input: daySchema,
		setup: (input) => ({ message: input.day, state: { day: input.day } }),
		tools,
		limits: { steps: 1 },
	});
	const clock = fakeClock();
	const storage = memoryStorage();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel([{ toolCalls: [{ id: "c1", name: "read", args: {} }] }], { clock }),
		host: "test-host",
	});
	const started = runtime.start({
		runId: "run-1",
		task: "input-check",
		input: { day: "Monday" },
		definition: first,
	});
	if (!started.ok) {
		throw new Error(started.error.message);
	}
	expect((await started.value.outcome).reason).toBe("parked");
	const parked = await statusesOf(storage);
	expect(parked).toEqual(["running", "parked"]);

	const changed = defineRecipe({
		name: "input-check",
		version: 2,
		instructions: "build the page",
		input: { type: "object", properties: { when: { type: "string" } }, required: ["when"] },
		setup: (input) => ({ message: input.when, state: { when: input.when } }),
		tools,
	});
	const woken = await runtime.wake({
		runId: "run-1",
		task: "input-check",
		definition: changed,
	});
	if (!woken.ok) {
		throw new Error(woken.error.message);
	}
	expect((await woken.value.outcome).parkedReason).toBe("limit");
	expect(await statusesOf(storage)).toEqual(parked);
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
