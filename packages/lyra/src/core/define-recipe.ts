/**
 * A recipe: a task's instructions, its input, its tools, its limits, and what done
 * means (docs/recipes-and-tools.md, RCP01 to RCP06; decision 5).
 *
 * `defineRecipe` checks the whole thing where it is written, not on a person's first
 * day: a duplicate tool name, a schema the subset cannot compile, a `finish` with no
 * done-check and a limit that can never be met are all refused at module load. The
 * input schema is kept as plain JSON Schema, and the runtime validates a run's input
 * against it before anything is saved.
 */

import { isJsonValue, type JsonObject, type JsonValue } from "./json.js";
import { isPositiveInteger, validateLimits, type Limits } from "./limits.js";
import { compileSchema, SchemaDefinitionError, type InferSchema } from "./schema.js";
import type { CompactionSettings } from "./compaction.js";
import { validateCompactionSettings } from "./compaction.js";
import type { ApprovalSettings, RunEnding, StuckSettings } from "./run.js";
import { isRunEnding } from "./run.js";
import type { Tool } from "./tool.js";

export class RecipeDefinitionError extends Error {
	override readonly name = "RecipeDefinitionError";
}

/**
 * The recipe as the runtime and the core see it: the input is already checked, so
 * `setup` takes plain JSON. `defineRecipe` wraps a typed setup into this shape.
 */
export interface Recipe<S = unknown> {
	name: string;
	version: number;
	/** The instructions the model is given, which is the run's system text. */
	instructions: string;
	/** The schema the task's input must match, when the recipe wants one checked. */
	input?: JsonObject;
	/** Builds the first message and the initial state from the input (decision 112). */
	setup?(input: JsonValue): { message: string; state: S };
	tools: readonly Tool[];
	limits?: Limits;
	fallbackModel?: string;
	stuck?: StuckSettings;
	/** How the run compacts when its history outgrows the model's window (decision 41). */
	compaction?: CompactionSettings;
	/** How the run asks a person: its default policy and a timeout (decisions 35, 37). */
	approvals?: ApprovalSettings;
	/**
	 * How many of one reply's calls may run at the same time (decision 154). Absent
	 * means the core's default, and a tool still has to opt in before it joins a
	 * group.
	 */
	maxParallelCalls?: number;
	/**
	 * How the run ends (issue #106). Absent means `done-check`, which is decision 25's
	 * rule; `reply` makes the model's own reply the deliverable. Refused together with
	 * a `finish` tool, because two things would claim to be the ending.
	 */
	ending?: RunEnding;
}

function refuse(message: string): never {
	throw new RecipeDefinitionError(message);
}

function checkText(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		return refuse(`a recipe needs a ${field}`);
	}
	return value;
}

export function defineRecipe<const I extends JsonObject, S = unknown>(options: {
	name: string;
	version: number;
	instructions: string;
	input: I;
	setup(input: InferSchema<I>): { message: string; state: S };
	tools: readonly Tool[];
	limits?: Limits;
	fallbackModel?: string;
	stuck?: StuckSettings;
	compaction?: CompactionSettings;
	approvals?: ApprovalSettings;
	maxParallelCalls?: number;
	ending?: RunEnding;
}): Recipe<S> {
	const name = checkText(options.name, "name");
	checkText(options.instructions, "instructions");
	if (
		typeof options.version !== "number" ||
		!Number.isSafeInteger(options.version) ||
		options.version < 1
	) {
		refuse("a recipe needs a version of one or more");
	}
	if (typeof options.setup !== "function") {
		refuse("a recipe needs a setup, which makes the first message and the state");
	}
	try {
		compileSchema(options.input, "input");
	} catch (error) {
		if (error instanceof SchemaDefinitionError) {
			refuse(`a recipe's input schema is not one this build can check: ${error.message}`);
		}
		throw error;
	}

	const names = new Set<string>();
	for (const tool of options.tools) {
		if (typeof tool.spec.name !== "string" || tool.spec.name === "") {
			refuse("a recipe has a tool with no name");
		}
		if (names.has(tool.spec.name)) {
			refuse(`a recipe has two tools called "${tool.spec.name}"`);
		}
		names.add(tool.spec.name);
		try {
			compileSchema(tool.spec.parameters, `the ${tool.spec.name} tool's parameters`);
		} catch (error) {
			if (error instanceof SchemaDefinitionError) {
				refuse(
					`the ${tool.spec.name} tool has parameters this build cannot check: ${error.message}`,
				);
			}
			throw error;
		}
	}
	const finish = options.tools.find((tool) => tool.spec.name === "finish");
	if (finish !== undefined && finish.finish !== true) {
		refuse(
			'a recipe has a tool called "finish" that was not made by createFinishTool, so its word that the job is done is not checked',
		);
	}
	// An ending this build does not know is a recipe written for a later one, and the
	// silent answer would be whichever ending the default happens to be.
	if (options.ending !== undefined && !isRunEnding(options.ending)) {
		refuse(
			`a recipe's ending must be "reply" or "done-check", not "${String(options.ending)}"`,
		);
	}
	// Two things claiming to be the ending is the ambiguity decision 115 refuses at
	// definition time: a reply that ends the run and a finish that ends it would
	// disagree about what the record's last act actually meant.
	if (options.ending === "reply" && finish !== undefined) {
		refuse(
			"a recipe that ends on its reply cannot also carry a finish tool: two things would claim to be the ending",
		);
	}

	if (options.limits !== undefined) {
		const limits = validateLimits(options.limits);
		if (!limits.ok) {
			refuse(`a recipe's limits cannot be enforced: ${limits.error.message}`);
		}
	}
	if (options.compaction !== undefined) {
		const compaction = validateCompactionSettings(options.compaction);
		if (!compaction.ok) {
			refuse(`a recipe's compaction settings cannot be used: ${compaction.error.message}`);
		}
	}
	// A cap nobody can honour is a recipe's mistake, and it is refused where it is
	// written rather than quietly replaced by the default (decision 154).
	if (options.maxParallelCalls !== undefined && !isPositiveInteger(options.maxParallelCalls)) {
		refuse("a recipe's maxParallelCalls must be a positive whole number");
	}

	const recipe: Recipe<S> = {
		name,
		version: options.version,
		instructions: options.instructions,
		input: isJsonValue(options.input) ? options.input : refuse("a recipe's input must be JSON"),
		// The input was checked against the schema just above, and every call here
		// comes through this function, so the cast is the same one `defineTool` makes.
		setup: (input) => options.setup(input as InferSchema<I>),
		tools: options.tools,
	};
	if (options.limits !== undefined) {
		recipe.limits = options.limits;
	}
	if (options.fallbackModel !== undefined) {
		recipe.fallbackModel = options.fallbackModel;
	}
	if (options.stuck !== undefined) {
		recipe.stuck = options.stuck;
	}
	if (options.compaction !== undefined) {
		recipe.compaction = options.compaction;
	}
	if (options.approvals !== undefined) {
		recipe.approvals = options.approvals;
	}
	if (options.maxParallelCalls !== undefined) {
		recipe.maxParallelCalls = options.maxParallelCalls;
	}
	if (options.ending !== undefined) {
		recipe.ending = options.ending;
	}
	return recipe;
}
