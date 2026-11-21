/**
 * The scripted model (docs/engineering-practices.md, KIT02 and KIT03): what turns
 * a test into a run.
 *
 * It picks its reply from the conversation, not from a call counter. The reply is
 * the turn whose position equals the number of assistant messages already in the
 * request, so a run that is killed and re-asks the request in flight gets the same
 * answer back (the determinism step 2's resume tests depend on).
 *
 * Failures are scripted per turn and consumed in order, which is how a retry is
 * exercised without a network. A script with no turn left is a test bug, so it
 * answers with a loud non-retryable error rather than looping.
 */

import type { Clock } from "../core/clock.js";
import type { FinishReason, ModelReply, ModelRequest, ModelSlot, Usage } from "../core/model.js";
import type { ErrorCode, Result } from "../core/result.js";
import type { ModelError } from "../core/model.js";

export interface ScriptedToolCall {
	id: string;
	name: string;
	/**
	 * An object is serialized, and a string is passed through untouched, so a test
	 * can send the invalid JSON a real model sends.
	 */
	args?: unknown;
}

export interface ScriptedFailure {
	code?: ErrorCode;
	message?: string;
	retryable?: boolean;
	retryAfterMs?: number;
}

export interface ScriptedTurn {
	text?: string;
	reasoning?: string;
	toolCalls?: ScriptedToolCall[];
	usage?: Usage;
	finishReason?: FinishReason;
	/** Waits on the fake clock, so a test decides when the model answers. */
	delayMs?: number;
	/** Returned, in order, before this turn succeeds. */
	failures?: ScriptedFailure[];
}

export interface ScriptedModelOptions {
	clock: Clock;
	/** The name a reply reports. Defaults to `scripted/model`. */
	model?: string;
}

export interface ScriptedModel extends ModelSlot {
	/** Every request received, in order. */
	requests: ModelRequest[];
}

/** An argument value as the wire would carry it: an object serialized, a string as it is. */
export function scriptedArguments(args: unknown): string {
	if (args === undefined) {
		return "{}";
	}
	return typeof args === "string" ? args : JSON.stringify(args);
}

function replyFor(turn: ScriptedTurn, model: string): ModelReply {
	const toolCalls = (turn.toolCalls ?? []).map((call) => ({
		id: call.id,
		name: call.name,
		arguments: scriptedArguments(call.args),
	}));
	const reply: ModelReply = {
		text: turn.text ?? "",
		toolCalls,
		usage: turn.usage ?? { inputTokens: 0, outputTokens: 0 },
		finishReason: turn.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
		model,
	};
	if (turn.reasoning !== undefined) {
		reply.reasoning = turn.reasoning;
	}
	return reply;
}

export function scriptedModel(
	turns: readonly ScriptedTurn[],
	options: ScriptedModelOptions,
): ScriptedModel {
	const model = options.model ?? "scripted/model";
	const requests: ModelRequest[] = [];
	/** How many of a turn's scripted failures have been spent. */
	const spent = new Map<number, number>();

	return {
		requests,

		async complete(request): Promise<Result<ModelReply, ModelError>> {
			requests.push(request);

			const position = request.messages.filter(
				(message) => message.role === "assistant",
			).length;
			const turn = turns[position];
			if (turn === undefined) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: `the scripted model has no turn ${position + 1}: the script has ${turns.length}`,
						retryable: false,
					},
				};
			}

			const used = spent.get(position) ?? 0;
			const failure = turn.failures?.[used];
			if (failure !== undefined) {
				spent.set(position, used + 1);
				const error: ModelError = {
					code: failure.code ?? "provider_error",
					message:
						failure.message ?? `scripted failure ${used + 1} of turn ${position + 1}`,
					retryable: failure.retryable ?? true,
				};
				if (failure.retryAfterMs !== undefined) {
					error.retryAfterMs = failure.retryAfterMs;
				}
				return { ok: false, error };
			}

			if (turn.delayMs !== undefined && turn.delayMs > 0) {
				await options.clock.sleep(turn.delayMs, request.signal);
			}

			return { ok: true, value: replyFor(turn, model) };
		},
	};
}
