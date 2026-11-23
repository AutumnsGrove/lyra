/**
 * Committed cases for MOD10 (`core/decode-reply.fuzz.test.ts`). Each one is a
 * reply shape a provider or a proxy has plausibly sent: a tool call with a
 * stringified argument object, a reply cut off by the token limit, a usage block
 * with negative counts, and the values that make `JSON.parse` the wrong tool.
 *
 * They are written here rather than generated so they replay on every gate run
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
