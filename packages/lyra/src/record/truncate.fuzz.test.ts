import fc from "fast-check";
import { test } from "vitest";

import type { JsonValue } from "../core/json.js";
import { generate } from "../testkit/corpus.testing.js";
import type { RecordEntry } from "./entries.js";
import { holds } from "./corpus/truncate.testing.js";

/**
 * REC04 in `docs/run-record.md`: no size of content can make a save fail or fail
 * a run for size. Whatever is generated, a fitted entry is either refused for its
 * structure alone or fits the cap and loads back as it was saved.
 */

const bigText = fc.string({ minLength: 0, maxLength: 8_000 });

function jsonOf(depth = 2): fc.Arbitrary<JsonValue> {
	const leaf = fc.oneof(
		fc.string({ maxLength: 500 }),
		fc.nat({ max: 1_000 }),
		fc.boolean(),
		fc.constant(null),
	);
	if (depth === 0) {
		return leaf;
	}
	return fc.oneof(
		leaf,
		fc.array(jsonOf(depth - 1), { maxLength: 3 }),
		fc.dictionary(fc.stringMatching(/^[a-z]{1,5}$/), jsonOf(depth - 1), { maxKeys: 3 }),
	);
}

const toolEntry = fc
	.record({ content: bigText, details: fc.option(jsonOf(), { nil: undefined }) })
	.map(({ content, details }): RecordEntry => {
		const entry: RecordEntry = {
			type: "tool_message",
			id: "e1",
			parent: null,
			ts: 1_700_000_000_000,
			toolCallId: "c1",
			isError: false,
			content,
		};
		if (details !== undefined) {
			entry.details = details;
		}
		return entry;
	});

const assistantEntry = fc
	.record({
		text: bigText,
		reasoning: fc.option(bigText, { nil: undefined }),
		arguments: fc.array(bigText, { maxLength: 3 }),
	})
	.map(({ text, reasoning, arguments: args }): RecordEntry => {
		const entry: RecordEntry = {
			type: "assistant_message",
			id: "e2",
			parent: null,
			ts: 1_700_000_000_000,
			text,
			toolCalls: args.map((argument, index) => ({
				id: `c${index}`,
				name: "read",
				arguments: argument || "{}",
			})),
			model: "scripted/model",
			usage: { inputTokens: 1, outputTokens: 2 },
			finishReason: "tool_calls",
		};
		if (reasoning !== undefined) {
			entry.reasoning = reasoning;
		}
		return entry;
	});

test("REC04 any entry and any cap: either it fits and loads back, or it is refused for its structure", () => {
	generate(
		"truncate",
		fc.tuple(fc.oneof(toolEntry, assistantEntry), fc.integer({ min: 200, max: 20_000 })),
		holds,
		{
			numRuns: 300,
		},
	);
});
