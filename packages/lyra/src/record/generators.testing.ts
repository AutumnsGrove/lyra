import fc from "fast-check";

import type { JsonObject, JsonValue } from "../core/json.js";
import type { FinishReason, ToolCall, Usage } from "../core/model.js";
import type { MessageLabel, RecordEntry, RecordHeader, RunState } from "./entries.js";

/**
 * Generators for the record's property and fuzz tests (RCD06 and RCD07 in
 * `docs/run-record.md`). They build only what the format allows: a chain where
 * every entry names the one before it, ids that do not repeat, and fields that
 * are either present and valid or absent, never present and empty.
 *
 * This file is test support, not test or library code, so it is excluded from
 * the build and from coverage, and it may import the dev tooling.
 */

const text = fc.string({ maxLength: 20 });
const word = fc.stringMatching(/^[a-z_]{1,10}$/);
const LABELS: MessageLabel[] = ["task", "steer", "follow_up", "reminder"];
const STATES: RunState[] = ["running", "parked", "done", "failed", "resumed"];
const FINISH_REASONS: FinishReason[] = ["stop", "length", "tool_calls", "content_filter", "other"];

/**
 * JSON of our own, rather than fast-check's `fc.jsonValue()`, whose recursive
 * type is not assignable to ours through a generic. Two levels is enough for a
 * tool's detail, and the loader's own depth cap is what a real hostile document
 * would test.
 */
function jsonValueArbitrary(depth = 2): fc.Arbitrary<JsonValue> {
	const leaf = fc.oneof(
		fc.string({ maxLength: 10 }),
		fc.nat({ max: 1_000 }),
		fc.boolean(),
		fc.constant(null),
	);
	if (depth === 0) {
		return leaf;
	}
	const nested: fc.Arbitrary<JsonValue> = fc.oneof(
		fc.array(jsonValueArbitrary(depth - 1), { maxLength: 2 }),
		fc.dictionary(word, jsonValueArbitrary(depth - 1), {
			maxKeys: 2,
		}) as fc.Arbitrary<JsonObject>,
	);
	return fc.oneof(leaf, nested);
}

const usageArbitrary = (): fc.Arbitrary<Usage> =>
	fc
		.record({
			inputTokens: fc.nat({ max: 100_000 }),
			outputTokens: fc.nat({ max: 100_000 }),
			cost: fc.option(
				fc.record({
					amount: fc.nat({ max: 1_000 }),
					source: fc.constantFrom("provider", "allowance", "catalog"),
				}),
				{ nil: undefined },
			),
		})
		.map(({ cost, ...rest }) =>
			cost === undefined ? rest : { ...rest, cost: { ...cost, currency: "USD" as const } },
		);

/** Ids come from the position, so a chain's links are always valid. */
const toolCallsArbitrary = (index: number): fc.Arbitrary<ToolCall[]> =>
	fc
		.array(fc.record({ name: word, arguments: fc.string({ maxLength: 20 }) }), { maxLength: 3 })
		.map((calls) => calls.map((call, position) => ({ id: `e${index}c${position}`, ...call })));

export function headerArbitrary(): fc.Arbitrary<RecordHeader> {
	return fc
		.record({
			run: word,
			task: text,
			startedAt: fc.nat({ max: 2 ** 41 }),
			host: text,
			recipe: fc.option(
				fc.record({
					name: word,
					version: fc.nat({ max: 99 }),
					toolSetHash: fc.stringMatching(/^[0-9a-f]{1,16}$/),
				}),
				{ nil: undefined },
			),
		})
		.map(({ recipe, ...rest }) =>
			recipe === undefined
				? { type: "header" as const, v: 1, ...rest }
				: { type: "header" as const, v: 1, ...rest, recipe },
		);
}

function entryArbitrary(
	kind: "user" | "assistant" | "tool" | "status" | "note" | "fallback",
	index: number,
): fc.Arbitrary<RecordEntry> {
	const base = {
		id: `e${index}`,
		parent: index === 0 ? null : `e${index - 1}`,
		ts: 1_700_000_000_000 + index,
	};
	switch (kind) {
		case "user":
			return fc
				.record({ label: fc.constantFrom(...LABELS), text })
				.map((rest) => ({ type: "user_message" as const, ...base, ...rest }));
		case "assistant":
			return fc
				.record({
					text,
					reasoning: fc.option(text, { nil: undefined }),
					toolCalls: toolCallsArbitrary(index),
					model: word,
					usage: usageArbitrary(),
					finishReason: fc.constantFrom(...FINISH_REASONS),
					retries: fc.option(fc.nat({ max: 3 }), { nil: undefined }),
				})
				.map(({ reasoning, retries, ...rest }) => {
					const entry = { type: "assistant_message" as const, ...base, ...rest };
					if (reasoning !== undefined) {
						return {
							...entry,
							reasoning,
							...(retries === undefined ? {} : { retries }),
						};
					}
					return retries === undefined ? entry : { ...entry, retries };
				});
		case "tool":
			return fc
				.record({
					toolCallId: word,
					isError: fc.boolean(),
					content: text,
					details: fc.option(jsonValueArbitrary(), { nil: undefined }),
				})
				.map(({ details, ...rest }) =>
					details === undefined
						? { type: "tool_message" as const, ...base, ...rest }
						: { type: "tool_message" as const, ...base, ...rest, details },
				);
		case "status":
			return fc
				.record({
					state: fc.constantFrom(...STATES),
					reason: fc.option(word, { nil: undefined }),
					detail: fc.option(word, { nil: undefined }),
				})
				.map(({ reason, detail, ...rest }) => {
					const withReason = reason === undefined ? rest : { ...rest, reason };
					return detail === undefined
						? { type: "status" as const, ...base, ...withReason }
						: { type: "status" as const, ...base, ...withReason, detail };
				});
		case "note":
			return fc
				.record({ kind: word, text })
				.map((rest) => ({ type: "note" as const, ...base, ...rest }));
		case "fallback":
			return fc
				.record({ from: word, to: word, reason: text })
				.map((rest) => ({ type: "fallback" as const, ...base, ...rest }));
	}
}

/** A whole valid record chain, in the order it would be saved. */
export function entriesArbitrary(): fc.Arbitrary<RecordEntry[]> {
	return fc
		.array(fc.constantFrom("user", "assistant", "tool", "status", "note", "fallback"), {
			maxLength: 5,
		})
		.chain((kinds) =>
			kinds.length === 0
				? fc.constant<RecordEntry[]>([])
				: fc
						.tuple(...kinds.map((kind, index) => entryArbitrary(kind, index)))
						.map((entries) => [...entries]),
		);
}
