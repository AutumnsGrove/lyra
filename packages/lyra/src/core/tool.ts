/**
 * A tool, as step 1 keeps it.
 *
 * Step 3 adds recipes, argument validation and handles. What matters now is
 * that a tool receives untrusted arguments and can only answer with an outcome:
 * an error is a result the model corrects, and a thrown exception is caught by
 * the loop, so a tool can never take a run down (decision 21).
 */

import type { JsonObject } from "./json.js";
import type { ToolSpec } from "./model.js";

export interface ToolContext {
	/** Fires when the run is stopped or the tool's deadline passes. */
	signal: AbortSignal;
	runId: string;
	callId: string;
}

export interface ToolOutcome {
	isError: boolean;
	/** What the model reads. */
	content: string;
	/** Optional structured detail for a viewer. Never sent to the model. */
	details?: unknown;
	/**
	 * Set only by `finish`, once the job really is done (decision 25). Step 3
	 * gives `finish` the coverage check that makes this claim true.
	 */
	done?: true;
}

export interface Tool {
	spec: ToolSpec;
	/** Whether repeating it after an interruption is harmless (decision 24). Default no. */
	safeToRepeat?: boolean;
	execute(args: unknown, ctx: ToolContext): Promise<ToolOutcome>;
}

/** A tool with no parameters, which is the shape `finish` and the fakes have. */
export const NO_PARAMETERS: JsonObject = { type: "object", properties: {} };
