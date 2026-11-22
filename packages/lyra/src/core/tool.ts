/**
 * A tool, as step 1 keeps it.
 *
 * Step 3 adds recipes, argument validation and handles. What matters now is
 * that a tool receives untrusted arguments and can only answer with an outcome:
 * an error is a result the model corrects, and a thrown exception is caught by
 * the loop, so a tool can never take a run down (decision 21).
 */

import type { JsonObject, JsonValue } from "./json.js";
import type { ToolSpec } from "./model.js";
import {
	compileSchema,
	formatErrors,
	validateValue,
	type InferSchema,
	type Validation,
} from "./schema.js";

export type { InferSchema };

export interface ToolContext<S = unknown> {
	/** Fires when the run is stopped or the tool's deadline passes. */
	signal: AbortSignal;
	runId: string;
	callId: string;
	/**
	 * A stable name for this call across an interruption: `runId` and `callId`, so a
	 * tool that changes something can make repeating it harmless by deduping on this
	 * (decision 24).
	 */
	callKey: string;
	/**
	 * The recipe's state. A tool may read it here and must not change it: `apply` is
	 * the only writer, so a live run and a replayed one cannot drift (decision 112).
	 */
	state: S;
}

/** What a tool asks a person, when its work needs an answer rather than a yes. */
export interface PersonQuestion {
	kind: "question" | "choice";
	title: string;
	message: string;
	/** The thing to look at before answering. */
	preview?: JsonValue;
	/** What a choice offers, so an answer can only be one of them. */
	options?: { id: string; label: string }[];
}

export interface ToolOutcome {
	isError: boolean;
	/** What the model reads. */
	content: string;
	/** Optional structured detail for a viewer. Never sent to the model. */
	details?: JsonValue;
	/**
	 * Set only by `finish`, once the job really is done (decision 25). Step 3
	 * gives `finish` the coverage check that makes this claim true.
	 */
	done?: true;
	/**
	 * Set by a tool that needs a person before it can answer (decision 34). The
	 * run parks with the question, and the answer becomes this call's result.
	 */
	ask?: PersonQuestion;
}

export interface Tool {
	spec: ToolSpec;
	/** Whether repeating it after an interruption is harmless (decision 24). Default no. */
	safeToRepeat?: boolean;
	execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
	/**
	 * The check the loop runs before this tool executes, when the tool has a schema.
	 * A tool made by hand (a test fake) has none and is not checked.
	 */
	validate?(args: unknown): Validation<unknown>;
	/**
	 * The only place a recipe's state changes (decision 112). The core calls it after
	 * a successful execute, and again for every saved result on a resume.
	 */
	apply?(state: unknown, args: unknown, outcome: ToolOutcome): unknown;
	/**
	 * Set by `createFinishTool`, so `defineRecipe` can tell a real done-check from a
	 * tool that merely borrowed the name (RCP04).
	 */
	finish?: true;
	/**
	 * The exact text to show the model after a compaction (decision 40). It reads
	 * the recipe's rebuilt state and is never stored, so what the model sees after a
	 * cut is as exact as the tool can make it rather than a paraphrase in a summary.
	 */
	currentState?(state: unknown): string | undefined;
	/**
	 * How much of this tool's result the model may read at once, in bytes. The
	 * default is the run's, and a tool whose output is naturally large narrows it.
	 */
	maxResultBytes?: number;
	/** How to get the rest, said after a result was cut (decision 40). */
	truncationHint?: string;
	/** What the recipe says about running this tool without a person (decision 35). */
	policy?: import("./approval.js").ToolPolicy;
	/** What this tool does to the world, which sets its default policy (decision 35). */
	risk?: import("./approval.js").ToolRisk;
}

/** A tool with no parameters, which is the shape `finish` and the fakes have. */
export const NO_PARAMETERS: JsonObject = { type: "object", properties: {} };

export interface DefineToolOptions<A extends JsonObject, S> {
	name: string;
	description: string;
	parameters: A;
	safeToRepeat?: boolean;
	execute(args: InferSchema<A>, ctx: ToolContext<S>): Promise<ToolOutcome>;
	apply?(state: S, args: InferSchema<A>, outcome: ToolOutcome): S;
	/** What the model should be told this recipe's state is after a compaction. */
	currentState?(state: S): string | undefined;
	/** This tool's own cap on what the model reads from one result, in bytes. */
	maxResultBytes?: number;
	/** How to get the rest of a result that was cut. */
	truncationHint?: string;
	/** Allow, ask or deny this tool without a person (decision 35). */
	policy?: import("./approval.js").ToolPolicy;
	/** Reads, changes things, or dangerous, which sets the policy's default. */
	risk?: import("./approval.js").ToolRisk;
}

export function defineTool<const A extends JsonObject, S = unknown>(
	options: DefineToolOptions<A, S>,
): Tool {
	// A schema this build cannot compile is a tool author's mistake, and it is
	// thrown here rather than letting the tool silently check nothing (TOL04).
	const compiled = compileSchema(options.parameters);
	const apply = options.apply;

	const tool: Tool = {
		spec: {
			name: options.name,
			description: options.description,
			parameters: options.parameters,
		},
		validate: (args) => validateValue<InferSchema<A>>(compiled, args),
		execute: async (args, ctx) => {
			// The loop checks arguments before calling this, but a tool called directly
			// (a test, a later host) still never sees a value its schema refuses.
			const checked = validateValue<InferSchema<A>>(compiled, args);
			if (!checked.ok) {
				return { isError: true, content: formatErrors(checked.errors) };
			}
			return options.execute(checked.value, ctx as ToolContext<S>);
		},
	};
	if (options.safeToRepeat !== undefined) {
		tool.safeToRepeat = options.safeToRepeat;
	}
	if (options.currentState !== undefined) {
		const currentState = options.currentState;
		tool.currentState = (state) => currentState(state as S);
	}
	if (options.maxResultBytes !== undefined) {
		tool.maxResultBytes = options.maxResultBytes;
	}
	if (options.truncationHint !== undefined) {
		tool.truncationHint = options.truncationHint;
	}
	if (options.policy !== undefined) {
		tool.policy = options.policy;
	}
	if (options.risk !== undefined) {
		tool.risk = options.risk;
	}
	if (apply !== undefined) {
		tool.apply = (state, args, outcome) => {
			const checked = validateValue<InferSchema<A>>(compiled, args);
			if (!checked.ok) {
				return state;
			}
			return apply(state as S, checked.value, outcome);
		};
	}
	return tool;
}
