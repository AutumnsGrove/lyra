/**
 * `finish`, and the coverage check that makes its word worth something
 * (docs/recipes-and-tools.md, FIN01 to FIN06; decision 25).
 *
 * A run ends `done` when a tool answers with `done: true` and no error, so the
 * recipe has to be the one to say what done means. `createFinishTool({ check })`
 * takes that answer from the recipe's own state; a refusal is an ordinary error
 * result carrying the message, which the model reads and works from, and three
 * identical refusals park the run as stuck through step 2's safeguard instead of
 * spending an allowance on a loop that cannot finish.
 *
 * `coverageCheck` is the shape almost every recipe wants: every handle the day
 * produced is covered by a line, or left out with a stated reason. Its message is
 * sorted, so the same missing set always reads the same way.
 */

import type { JsonObject } from "./json.js";
import { compileSchema, formatErrors, validateValue } from "./schema.js";
import type { Tool, ToolOutcome } from "./tool.js";

export type DoneCheck = { ok: true } | { ok: false; message: string };

/** One thing the recipe agreed to leave out, and why. */
export interface Skipped {
	handle: string;
	reason: string;
}

/** The arguments `finish` takes: a list of what was left out, each with a reason. */
export interface FinishArguments {
	skipped?: Skipped[];
}

const PARAMETERS: JsonObject = {
	type: "object",
	properties: {
		skipped: {
			type: "array",
			maxItems: 200,
			items: {
				type: "object",
				properties: {
					handle: { type: "string", minLength: 1, maxLength: 80 },
					reason: { type: "string", maxLength: 500 },
				},
				required: ["handle", "reason"],
			},
		},
	},
};

export interface FinishOptions<S> {
	/** Whether the job is really done, in the recipe's own terms, given its state. */
	check(state: S, skipped: readonly Skipped[]): DoneCheck;
	/** What an accepted finish tells the model. */
	content?: string;
}

export function createFinishTool<S = unknown>(options: FinishOptions<S>): Tool {
	const compiled = compileSchema(PARAMETERS);
	const tool: Tool = {
		spec: {
			name: "finish",
			description:
				"End the run when the job is really done. Everything the task must cover has to be covered by a line, or skipped with a reason.",
			parameters: PARAMETERS,
		},
		// `defineRecipe` uses this to tell a real done-check from a tool that merely
		// borrowed the name (RCP04).
		finish: true,
		// The check is pure, and a kill between the call and its result leaves the run
		// with nothing that running it again could duplicate.
		safeToRepeat: true,
		validate: (args) => validateValue<FinishArguments>(compiled, args),
		execute: async (args, ctx) => {
			const checked = validateValue<FinishArguments>(compiled, args);
			if (!checked.ok) {
				return { isError: true, content: formatErrors(checked.errors) };
			}
			const skipped = checked.value.skipped ?? [];
			for (const item of skipped) {
				if (item.reason.trim() === "") {
					// A skip without a reason is not a skip; it is a thing left out.
					return {
						isError: true,
						content: `a skip needs a reason: say why ${item.handle} is left out of the page`,
					};
				}
			}
			const decision = options.check(ctx.state as S, skipped);
			if (!decision.ok) {
				return { isError: true, content: decision.message };
			}
			const outcome: ToolOutcome = {
				isError: false,
				content: options.content ?? "finished",
				done: true,
			};
			if (skipped.length > 0) {
				outcome.details = {
					skipped: skipped.map((item) => ({ handle: item.handle, reason: item.reason })),
				};
			}
			return outcome;
		},
	};
	return tool;
}

export interface CoverageRequest {
	/** The handles the task has to account for. */
	expected: readonly string[];
	/** The handles the state says are covered. */
	covered: Iterable<string>;
	/** What they are called in the message, such as `issues`. */
	label: string;
	/** Handles the recipe agreed to leave out, each with its reason. */
	skipped?: readonly Skipped[];
	/** How many missing handles the message names. Twelve by default. */
	cap?: number;
}

const DEFAULT_COVERAGE_CAP = 12;

/** "not covered yet: 4 issues (i3, i7, i9, i12)", with the missing set sorted. */
export function coverageCheck(request: CoverageRequest): DoneCheck {
	const accounted = new Set(request.covered);
	for (const item of request.skipped ?? []) {
		accounted.add(item.handle);
	}
	const missing = [...new Set(request.expected)]
		.filter((handle) => !accounted.has(handle))
		.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
	if (missing.length === 0) {
		return { ok: true };
	}
	const cap = request.cap ?? DEFAULT_COVERAGE_CAP;
	const shown = missing.slice(0, cap).join(", ");
	const left = missing.length - cap;
	const list = left > 0 ? `${shown}, and ${left} more` : shown;
	// A label is written in the plural, because that is how a task names its world.
	const noun =
		missing.length === 1 && request.label.endsWith("s")
			? request.label.slice(0, -1)
			: request.label;
	return { ok: false, message: `not covered yet: ${missing.length} ${noun} (${list})` };
}
