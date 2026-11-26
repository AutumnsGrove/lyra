/**
 * The scripted model a smoke run uses (issue #60, slice 7; PGS41 and PGS42).
 *
 * A deploy that is only ever tested from the inside is a deploy nothing has driven from
 * outside. The smoke job therefore sends `x-lyra-script` with a list of turns, and the run
 * answers those turns instead of asking a provider: the assertions are exact, and a smoke
 * run costs nothing. Two rules make that safe on a deployment a person also uses.
 *
 * **The header is only accepted from the smoke tenant.** The tenant is never taken from the
 * header — it is the one the bearer token resolved to — and scripts are allowed only for the
 * tenant named by `LYRA_PLAYGROUND_SMOKE_TENANT`, so a script cannot reach a person's
 * conversation. **The token is compared exactly and only when set**, so a deployment with no
 * `LYRA_PLAYGROUND_SCRIPT_TOKEN` refuses the header rather than quietly falling back to the
 * real model: a smoke job against a deployment that cannot be scripted has to fail loudly.
 */

import type {
	FinishReason,
	ModelError,
	ModelReply,
	ModelSlot,
	Result,
	ToolCall,
} from "@autumnsgrove/lyra";
import { fail, ok } from "@autumnsgrove/lyra";

/** The largest script a header may carry, so a request cannot be a payload. */
export const MAX_SCRIPT_BYTES = 16 * 1024;

/** One turn of a script, which is one reply the model would have given. */
export interface ScriptTurn {
	text?: string;
	toolCalls?: ToolCall[];
	finishReason?: FinishReason;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function callsOf(value: unknown): ToolCall[] | undefined {
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value)) {
		return undefined;
	}
	const calls: ToolCall[] = [];
	for (const call of value) {
		if (!isRecord(call)) {
			return undefined;
		}
		const id = call["id"];
		const name = call["name"];
		const args = call["arguments"];
		if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
			return undefined;
		}
		calls.push({ id, name, arguments: args });
	}
	return calls;
}

/**
 * A header's script, or the refusal that says why it is not one.
 *
 * A script is a list of turns, and a turn either says something or calls something. An empty
 * list is refused rather than accepted as a run that does nothing: a smoke job with nothing
 * to assert is a mistake, not a test.
 */
export function decodeScript(raw: string | null | undefined): Result<ScriptTurn[]> {
	if (typeof raw !== "string" || raw === "") {
		return fail("bad_request", "a script is a list of turns, as JSON");
	}
	// Bytes, not characters: a script of multi-byte text would otherwise pass a cap named
	// in bytes at several times the size (the same mistake the API body had).
	if (new TextEncoder().encode(raw).length > MAX_SCRIPT_BYTES) {
		return fail("bad_request", `a script may be at most ${MAX_SCRIPT_BYTES} bytes`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return fail("bad_request", "a script is a list of turns, as JSON");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		return fail("bad_request", "a script is a non-empty list of turns");
	}

	const turns: ScriptTurn[] = [];
	for (const [index, turn] of parsed.entries()) {
		if (!isRecord(turn)) {
			return fail("bad_request", `turn ${index} is not an object`);
		}
		const text = turn["text"];
		if (text !== undefined && typeof text !== "string") {
			return fail("bad_request", `turn ${index} has a text that is not a string`);
		}
		// Either spelling is read, and either spelling is checked: testing only the snake_case
		// key let `toolCalls: "bad"` on a turn with text through, and a mistyped call that
		// silently becomes a text-only turn is a smoke job asserting less than it wrote
		// (review on #101).
		const rawCalls = turn["tool_calls"] ?? turn["toolCalls"];
		const toolCalls = callsOf(rawCalls);
		if (rawCalls !== undefined && toolCalls === undefined) {
			return fail("bad_request", `turn ${index} has tool_calls that are not a list of calls`);
		}
		if (text === undefined && (toolCalls === undefined || toolCalls.length === 0)) {
			return fail("bad_request", `turn ${index} says nothing and calls nothing`);
		}
		const finishReason = turn["finish_reason"] ?? turn["finishReason"];
		const knownReasons: readonly string[] = ["stop", "length", "tool_calls", "content_filter"];
		if (typeof finishReason !== "undefined" && !knownReasons.includes(String(finishReason))) {
			return fail(
				"bad_request",
				`turn ${index} has a finish_reason this build does not know`,
			);
		}
		turns.push({
			...(text === undefined ? {} : { text }),
			...(toolCalls === undefined ? {} : { toolCalls }),
			...(typeof finishReason === "string"
				? { finishReason: finishReason as FinishReason }
				: {}),
		});
	}
	return ok(turns);
}

/**
 * The model a scripted run asks: one reply per turn, in order.
 *
 * When the turns run out it fails rather than repeating the last one, because a run whose
 * script is too short should be a red smoke job, not a run that quietly invents a turn.
 */
export function scriptedSlot(turns: readonly ScriptTurn[]): ModelSlot {
	let served = 0;
	return {
		async complete(): Promise<Result<ModelReply, ModelError>> {
			const turn = turns[served];
			if (turn === undefined) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: `the script has ${turns.length} turn(s) and the run asked for another`,
						retryable: false,
					},
				};
			}
			served += 1;
			return {
				ok: true,
				value: {
					text: turn.text ?? "",
					toolCalls: turn.toolCalls ?? [],
					// No cost, because no model was called: the same rule the placeholder follows,
					// and the reason a scripted smoke run cannot mark the day unpriced (nothing
					// reports its spend).
					usage: { inputTokens: 0, outputTokens: 0 },
					finishReason:
						turn.finishReason ??
						((turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop"),
					model: "playground-script",
				},
			};
		},
	};
}

/**
 * Whether a header carries the token, compared without an early exit.
 *
 * The length check is not a secret: a token's length is its shape. The loop runs over the
 * longer of the two so a caller cannot learn a prefix from how long the comparison took.
 */
export function tokenMatches(expected: string, presented: string): boolean {
	if (expected === "" || presented === "") {
		return false;
	}
	let difference = expected.length === presented.length ? 0 : 1;
	const length = Math.max(expected.length, presented.length);
	for (let index = 0; index < length; index += 1) {
		difference |= (expected.charCodeAt(index) ?? 0) ^ (presented.charCodeAt(index) ?? 0);
	}
	return difference === 0;
}
