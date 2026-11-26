/**
 * The tools whose shape is the point (issue #60, slice 5).
 *
 * A rig needs a tool that fails, a tool that takes time, and a tool whose answer is
 * bigger than anything a record should hold, because those are the three things a run
 * does that a page has to draw honestly. None of them keeps state, so none of them has
 * an `apply` and each may run beside another call.
 */

import { defineTool, type Tool } from "@autumnsgrove/lyra";

/** How long a call may be made to wait. Long enough to see, short enough to survive. */
const MAX_WAIT_MS = 5_000;

/** The largest result this tool will build, which is under the record's 1 MiB entry cap. */
const MAX_RESULT_BYTES = 400_000;

/**
 * Fails twice and then works.
 *
 * The count is this tool's own memory rather than the recipe's state, and that is
 * deliberate: an error result is skipped when a resume rebuilds state (decision 112), so
 * a counter kept in `apply` would never move and the tool would fail for ever.
 *
 * The cost is where the count lives. It lasts as long as the recipe instance, which is
 * as long as the session's Durable Object: after the first success in a conversation,
 * `flaky` works for the rest of it, and a rebuild (an eviction) is what makes it fail
 * again. That is fine for a tool whose job is to make a model correct itself once, and
 * the row says so rather than leaving it to be discovered.
 */
export function flakyTool(): Tool {
	let calls = 0;
	return defineTool({
		name: "flaky",
		description: "A tool that fails twice and then works; call it again when it fails.",
		parameters: { type: "object", properties: {} },
		// Calling it again is the point, so it is not a mistake to repeat.
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async () => {
			calls += 1;
			if (calls < 3) {
				return {
					isError: true,
					content: `flaky failed on purpose (attempt ${calls}); call it again and it will work`,
					details: { attempt: calls },
				};
			}
			return {
				isError: false,
				content: `flaky worked on attempt ${calls}`,
				details: { attempt: calls },
			};
		},
	});
}

/** What a slow call waits with, passed in so a test does not wait on a real clock. */
export interface SlowOptions {
	sleep?: (ms: number) => Promise<void>;
}

/** Waits for as long as it is told, within a bound the schema enforces. */
export function slowTool(options: SlowOptions = {}): Tool {
	const sleep =
		options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	return defineTool({
		name: "slow",
		description: `Wait a little, then answer. Between 1 and ${MAX_WAIT_MS} milliseconds.`,
		parameters: {
			type: "object",
			properties: { ms: { type: "integer", minimum: 1, maximum: MAX_WAIT_MS } },
			required: ["ms"],
		},
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (args) => {
			await sleep(args.ms);
			return { isError: false, content: `waited ${args.ms} ms`, details: { ms: args.ms } };
		},
	});
}

/** Answers more than one record entry can hold, so the loop's cap has something to cut. */
export function bigResultTool(): Tool {
	return defineTool({
		name: "big_result",
		description: `Answer with a large result, up to ${MAX_RESULT_BYTES} bytes.`,
		parameters: {
			type: "object",
			properties: { bytes: { type: "integer", minimum: 1, maximum: MAX_RESULT_BYTES } },
		},
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (args) => {
			const bytes = args.bytes ?? MAX_RESULT_BYTES;
			const content = "x".repeat(bytes);
			return { isError: false, content, details: { bytes } };
		},
	});
}
