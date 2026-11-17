import fc from "fast-check";

import type { FinishReason } from "./model.js";
import type { ScriptedToolCall, ScriptedTurn } from "../testkit/index.js";

/**
 * Random scripts for LOOP12 (docs/core-loop.md): a model that misbehaves in the
 * ways a model really does, tools that fail in each way a tool can, a run stopped
 * at a random moment, and a storage that fails at a random append.
 *
 * It is test support, so it is excluded from the build and from coverage, and the
 * seed of a failing run is printed by fast-check.
 */

export type ToolBehavior = "ok" | "error" | "throw" | "slow";

export interface LoopScript {
	turns: ScriptedTurn[];
	tools: { name: string; behavior: ToolBehavior }[];
	/** Abort the run when the nth event arrives, if the script stops it at all. */
	abortAfter?: number;
	/** Fail the nth append, if the storage fails at all. */
	failOn?: number;
}

const NAMES = ["alpha", "beta", "missing", "finish", ""];
const FINISH_REASONS: FinishReason[] = ["stop", "length", "tool_calls", "other"];

/** Text that is JSON, text that is not, and the shapes that parse and are still wrong. */
const args = fc.oneof(
	fc.constant(undefined),
	fc.record({ number: fc.nat({ max: 9 }) }),
	fc.constantFrom("{oops", "", "null", "[]", '"text"', "42"),
);

function turns(): fc.Arbitrary<ScriptedTurn[]> {
	return fc
		.array(
			fc.record({
				calls: fc.array(fc.record({ name: fc.constantFrom(...NAMES), args }), {
					maxLength: 3,
				}),
				finishReason: fc.option(fc.constantFrom(...FINISH_REASONS), { nil: undefined }),
				delayMs: fc.option(fc.integer({ min: 0, max: 200 }), { nil: undefined }),
				failures: fc.option(
					fc.array(
						fc.record({
							code: fc.constantFrom("provider_error", "timeout", "bad_request"),
							retryable: fc.boolean(),
						}),
						{ maxLength: 1 },
					),
					{ nil: undefined },
				),
				text: fc.string({ maxLength: 12 }),
			}),
			{ minLength: 1, maxLength: 4 },
		)
		.map((raw) =>
			raw.map((turn, index) => {
				const scripted: ScriptedTurn = {
					text: turn.text,
					toolCalls: turn.calls.map((call, position): ScriptedToolCall => ({
						id: `c${index}_${position}`,
						name: call.name,
						args: call.args,
					})),
					usage: { inputTokens: index, outputTokens: index + 1 },
				};
				if (turn.finishReason !== undefined) {
					scripted.finishReason = turn.finishReason;
				}
				if (turn.delayMs !== undefined) {
					scripted.delayMs = turn.delayMs;
				}
				if (turn.failures !== undefined) {
					scripted.failures = turn.failures;
				}
				return scripted;
			}),
		);
}

export function loopScriptArbitrary(): fc.Arbitrary<LoopScript> {
	return fc
		.record({
			turns: turns(),
			tools: fc.array(
				fc.record({
					name: fc.constantFrom("alpha", "beta"),
					behavior: fc.constantFrom<ToolBehavior>("ok", "error", "throw", "slow"),
				}),
				{ minLength: 0, maxLength: 2 },
			),
			abortAfter: fc.option(fc.integer({ min: 1, max: 40 }), { nil: undefined }),
			failOn: fc.option(fc.integer({ min: 1, max: 12 }), { nil: undefined }),
		})
		.map((script) => {
			const seen = new Set<string>();
			const tools = script.tools.filter((tool) => {
				if (seen.has(tool.name)) {
					return false;
				}
				seen.add(tool.name);
				return true;
			});
			return script.abortAfter === undefined && script.failOn === undefined
				? { turns: script.turns, tools }
				: {
						turns: script.turns,
						tools,
						...(script.abortAfter === undefined
							? {}
							: { abortAfter: script.abortAfter }),
						...(script.failOn === undefined ? {} : { failOn: script.failOn }),
					};
		});
}
