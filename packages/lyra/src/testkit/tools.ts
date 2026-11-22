/**
 * Tools made from data (docs/engineering-practices.md, "The test kit").
 *
 * A script says which tool the model calls; these make the tool. Each one exists
 * because it is a case the loop has to survive: a result, an error result, a
 * throw, and a tool that outstays its deadline on the fake clock.
 */

import type { Clock } from "../core/clock.js";
import type { JsonObject, JsonValue } from "../core/json.js";
import { NO_PARAMETERS, type Tool, type ToolOutcome } from "../core/tool.js";

/**
 * How many times a tool really ran, keyed by call id (KIT08). A resume must not
 * repeat a tool that changes something, and this is how a test proves it did not.
 */
export interface Executions {
	/** Called by a scripted tool, once, at the moment it starts. */
	record(callId: string): void;
	ids(): string[];
	count(callId: string): number;
	total(): number;
}

export function executionCounter(): Executions {
	const seen: string[] = [];
	return {
		record: (callId) => {
			seen.push(callId);
		},
		ids: () => [...seen],
		count: (callId) => seen.filter((seenId) => seenId === callId).length,
		total: () => seen.length,
	};
}

export interface ScriptedToolOptions {
	description?: string;
	parameters?: JsonObject;
	/** Whether the run may call it again after an interruption (decision 24). */
	safeToRepeat?: boolean;
	details?: JsonValue;
	/** Records every execution, so a test can count them across a resume. */
	executions?: Executions;
	/** This tool's own cap on what the model reads from one result, in bytes. */
	maxResultBytes?: number;
	/** How to get the rest of a result that was cut (decision 40). */
	truncationHint?: string;
}

function tool(name: string, execute: Tool["execute"], options: ScriptedToolOptions = {}): Tool {
	const spec = {
		name,
		description: options.description ?? `the ${name} tool, from the testkit`,
		parameters: options.parameters ?? NO_PARAMETERS,
	};
	const executions = options.executions;
	const counted: Tool["execute"] =
		executions === undefined
			? execute
			: async (args, ctx) => {
					executions.record(ctx.callId);
					return execute(args, ctx);
				};
	const made: Tool = { spec, execute: counted };
	if (options.safeToRepeat !== undefined) {
		made.safeToRepeat = options.safeToRepeat;
	}
	if (options.maxResultBytes !== undefined) {
		made.maxResultBytes = options.maxResultBytes;
	}
	if (options.truncationHint !== undefined) {
		made.truncationHint = options.truncationHint;
	}
	return made;
}

/** A tool that answers with fixed content. */
export function toolReturning(
	name: string,
	content: string,
	options: ScriptedToolOptions = {},
): Tool {
	return tool(
		name,
		async () => {
			const outcome: ToolOutcome = { isError: false, content };
			if (options.details !== undefined) {
				outcome.details = options.details;
			}
			return outcome;
		},
		options,
	);
}

/** A tool that answers with an error result, which the model is expected to read and correct. */
export function toolReturningError(
	name: string,
	content: string,
	options: ScriptedToolOptions = {},
): Tool {
	return tool(name, async () => ({ isError: true, content }), options);
}

/** A tool that throws. The loop must turn this into an error result, not a crash. */
export function toolThatThrows(
	name: string,
	message = `${name} threw`,
	options: ScriptedToolOptions = {},
): Tool {
	return tool(
		name,
		async () => {
			throw new Error(message);
		},
		options,
	);
}

/** A tool that takes its time on the fake clock, so a test can decide when it finishes. */
export function toolTakingTime(
	name: string,
	ms: number,
	clock: Clock,
	options: ScriptedToolOptions = {},
): Tool {
	return tool(
		name,
		async (_args, ctx) => {
			await clock.sleep(ms, ctx.signal);
			return { isError: false, content: `${name} finished after ${ms}ms` };
		},
		options,
	);
}

/**
 * `finish`, the tool that ends a run (decision 25). Step 3 gives it the coverage
 * check that makes its word worth something; here it only says the job is done.
 */
export function createFinishTool(options: { content?: string } = {}): Tool {
	return {
		spec: {
			name: "finish",
			description: "End the run when the job is really done.",
			parameters: { type: "object", properties: {} },
		},
		async execute() {
			return { isError: false, content: options.content ?? "finished", done: true };
		},
	};
}
