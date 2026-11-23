import { expect } from "vitest";

import { decodeReply } from "../decode-reply.js";

/**
 * The committed cases for MOD10, and the property they hold. Each case is a reply
 * shape a provider or a proxy has plausibly sent: a tool call with a stringified
 * argument object, a reply cut off by the token limit, a usage block with negative
 * counts, and the values that make `JSON.parse` the wrong tool.
 *
 * The property lives here so the generator in `decode-reply.fuzz.test.ts` and the
 * replay in `corpus/decode-reply.test.ts` share one definition. The replay is a
 * plain `.test.ts`, so `pnpm test` and the nightly shuffled run both cover it
 * (issue #41).
 */

export const cases: Readonly<Record<string, unknown>> = {
	"a-plain-answer": { text: "the answer", model: "test/model" },
	"a-tool-call-with-a-json-string": {
		text: "",
		model: "test/model",
		toolCalls: [{ id: "call_1", name: "search", arguments: '{"query":"lyra"}' }],
		finishReason: "tool_calls",
	},
	"cut-off-at-the-token-limit": {
		text: "half an ans",
		model: "test/model",
		finishReason: "length",
	},
	"a-usage-block-with-negative-counts": {
		text: "hi",
		model: "test/model",
		usage: { inputTokens: -1, outputTokens: -1 },
	},
	"tool-calls-that-are-not-a-list": { text: "hi", model: "test/model", toolCalls: "not a list" },
	"an-argument-that-is-already-an-object": {
		text: "",
		model: "test/model",
		toolCalls: [{ id: "call_1", name: "search", arguments: { query: "lyra" } }],
	},
	"two-tool-calls-with-the-same-id": {
		text: "",
		model: "test/model",
		toolCalls: [
			{ id: "call_1", name: "search", arguments: "{}" },
			{ id: "call_1", name: "search", arguments: "{}" },
		],
	},
	"a-line-separator-in-the-text": { text: "\u2028", model: "test/model" },
	"a-missing-model": { text: "hi" },
	"nothing-at-all": null,
};

/** The property: a value decodes or is refused, and what it accepts is a reply. */
export function holds(value: unknown): void {
	const result = decodeReply(value);
	if (!result.ok) {
		expect(result.error.code).toBe("bad_request");
		expect(typeof result.error.message).toBe("string");
		return;
	}
	const reply = result.value;
	expect(typeof reply.text).toBe("string");
	expect(typeof reply.model).toBe("string");
	expect(Number.isSafeInteger(reply.usage.inputTokens)).toBe(true);
	expect(reply.usage.inputTokens).toBeGreaterThanOrEqual(0);
	expect(Number.isSafeInteger(reply.usage.outputTokens)).toBe(true);
	expect(reply.usage.outputTokens).toBeGreaterThanOrEqual(0);
	expect(["stop", "length", "tool_calls", "content_filter", "other"]).toContain(
		reply.finishReason,
	);
	expect(Array.isArray(reply.toolCalls)).toBe(true);
	const ids = new Set<string>();
	for (const call of reply.toolCalls) {
		expect(call.id.length).toBeGreaterThan(0);
		expect(call.name.length).toBeGreaterThan(0);
		expect(typeof call.arguments).toBe("string");
		ids.add(call.id);
	}
	expect(ids.size).toBe(reply.toolCalls.length);
}
