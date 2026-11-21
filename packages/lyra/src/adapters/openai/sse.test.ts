import { describe, expect, test } from "vitest";

import { decodeReply } from "../../core/decode-reply.js";
import type { ModelError, ModelReply } from "../../core/model.js";
import type { Result } from "../../core/result.js";
import { DEFAULT_STREAM_CAP_BYTES, sseReader, type SseReader } from "./sse.js";

/**
 * A stream is written as the bytes a provider sends, so a test can cut it
 * anywhere, however awkward, and the assertions stay about what arrives rather
 * than about how the parser holds it (docs/adapters.md, OAI01 to OAI13).
 */

function event(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}): string {
	return event({
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 1_700_000_000,
		model: "test/model",
		choices: [{ index: 0, delta, finish_reason: null }],
		...extra,
	});
}

/** A reply from the reader, or the reason there is none. */
function replyOf(result: Result<ModelReply | undefined, ModelError>): ModelReply {
	if (!result.ok) {
		throw new Error(`expected a reply, got an error: ${result.error.message}`);
	}
	if (result.value === undefined) {
		throw new Error("expected a reply, got a reader waiting for more");
	}
	return result.value;
}

function errorOf(result: Result<unknown, ModelError>): ModelError {
	if (result.ok) {
		throw new Error("expected an error, got a value");
	}
	return result.error;
}

function feed(reader: SseReader, text: string): Result<ModelReply | undefined, ModelError> {
	return reader.push(text);
}

test("OAI01 a plain text stream assembles into one reply", () => {
	const reader = sseReader();
	feed(reader, chunk({ role: "assistant", content: "Hello" }));
	feed(reader, chunk({ content: " there" }));
	feed(
		reader,
		chunk(
			{ content: "" },
			{ choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] },
		),
	);
	const ended = feed(
		reader,
		event({
			model: "test/model",
			choices: [
				{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" },
			],
			usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.0004 },
		}) + "data: [DONE]\n\n",
	);

	const reply = replyOf(ended);
	expect(reply.text).toBe("Hello there");
	expect(reply.model).toBe("test/model");
	expect(reply.finishReason).toBe("stop");
	expect(reply.toolCalls).toEqual([]);
	expect(reply.usage).toEqual({
		inputTokens: 12,
		outputTokens: 5,
		cost: { amount: 0.0004, currency: "USD", source: "provider" },
	});
	// What the slot hands the loop has been through the core's decoder, so it is a
	// reply the loop already trusts.
	expect(decodeReply(reply).ok).toBe(true);
});

test("OAI02 a tool call split across chunks assembles with the id arriving late", () => {
	const reader = sseReader();
	feed(
		reader,
		event({
			model: "test/model",
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [{ index: 0, type: "function", function: { name: "read" } }],
					},
				},
			],
		}),
	);
	feed(
		reader,
		event({
			choices: [
				{
					index: 0,
					delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
				},
			],
		}),
	);
	feed(
		reader,
		event({
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{ index: 0, id: "call_9", function: { arguments: '"/a.txt"}' } },
						],
					},
				},
			],
		}),
	);
	const ended = feed(
		reader,
		event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n",
	);

	const reply = replyOf(ended);
	expect(reply.toolCalls).toEqual([
		{ id: "call_9", name: "read", arguments: '{"path":"/a.txt"}' },
	]);
	expect(reply.finishReason).toBe("tool_calls");
});

test("OAI03 two calls interleaved by index are kept apart and reported in order", () => {
	const reader = sseReader();
	const calls = (index: number, piece: Record<string, unknown>): string =>
		event({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...piece }] } }] });
	feed(reader, calls(1, { id: "call_b", function: { name: "second" } }));
	feed(reader, calls(0, { id: "call_a", function: { name: "first" } }));
	feed(reader, calls(0, { function: { arguments: '{"n":' } }));
	feed(reader, calls(1, { function: { arguments: '"two"}' } }));
	feed(reader, calls(0, { function: { arguments: "1}" } }));
	const ended = feed(
		reader,
		event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n",
	);

	expect(replyOf(ended).toolCalls).toEqual([
		{ id: "call_a", name: "first", arguments: '{"n":1}' },
		{ id: "call_b", name: "second", arguments: '"two"}' },
	]);
});

describe("OAI04 usage", () => {
	test("OAI04 in a separate chunk of its own", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "hi" }));
		feed(reader, event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		const ended = feed(
			reader,
			event({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }) +
				"data: [DONE]\n\n",
		);
		expect(replyOf(ended).usage).toEqual({ inputTokens: 7, outputTokens: 3 });
	});

	test("OAI04 missing usage is zero tokens and no cost", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "hi" }));
		const ended = feed(
			reader,
			event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
				"data: [DONE]\n\n",
		);
		expect(replyOf(ended).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	test("OAI04 a cost with no token counts still carries its source", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "hi" }));
		feed(reader, event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		const ended = feed(
			reader,
			event({ choices: [], usage: { cost: 0.5 } }) + "data: [DONE]\n\n",
		);
		expect(replyOf(ended).usage).toEqual({
			inputTokens: 0,
			outputTokens: 0,
			cost: { amount: 0.5, currency: "USD", source: "provider" },
		});
	});
});

test("OAI05 empty choices and a null content add nothing", () => {
	const reader = sseReader();
	feed(reader, chunk({ content: "one" }));
	feed(reader, event({ choices: [] }));
	feed(reader, chunk({ content: null }));
	feed(reader, event({ usage: { prompt_tokens: 2, completion_tokens: 1 } }));
	feed(reader, chunk({ content: " two" }));
	const ended = feed(
		reader,
		event({ choices: [{ index: 0, delta: { content: null }, finish_reason: "stop" }] }) +
			"data: [DONE]\n\n",
	);
	const reply = replyOf(ended);
	expect(reply.text).toBe("one two");
	expect(reply.toolCalls).toEqual([]);
});

describe("OAI06 a stream that stopped early", () => {
	test("OAI06 a stream cut in the middle of an event is a retryable error", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "half a reply" }));
		feed(reader, 'data: {"choices":[{"index":0,"delta":{"content":"and th');
		const error = errorOf(reader.end());
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("ended");
	});

	test("OAI06 a stream with no finish reason and no done marker is a retryable error", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "no ending" }));
		const error = errorOf(reader.end());
		expect(error.retryable).toBe(true);
		expect(error.code).toBe("provider_error");
	});

	test("OAI06 a done marker with no finish reason is complete", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "the whole answer" }));
		const reply = replyOf(feed(reader, "data: [DONE]\n\n"));
		expect(reply.text).toBe("the whole answer");
		// The provider said the stream was over, so it is over; a reason it did not
		// model is `other`, which is what the core does with any reason it cannot name.
		expect(reply.finishReason).toBe("other");
	});

	test("OAI06 a finish reason without a done marker is complete", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "done" }));
		feed(reader, event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }));
		const reply = reader.end();
		expect(reply.ok && reply.value.finishReason).toBe("length");
	});
});

test("OAI07 a call whose id never arrived gets a stable synthetic id", () => {
	const reader = sseReader();
	const calls = (index: number, piece: Record<string, unknown>): string =>
		event({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...piece }] } }] });
	feed(reader, calls(0, { function: { name: "a", arguments: "{}" } }));
	feed(reader, calls(1, { function: { name: "b", arguments: "{}" } }));
	const ended = feed(
		reader,
		event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n",
	);
	expect(replyOf(ended).toolCalls.map((call) => call.id)).toEqual(["call_1", "call_2"]);
});

test("OAI08 two calls sharing one id are both kept, the later one renamed", () => {
	const reader = sseReader();
	const calls = (index: number, piece: Record<string, unknown>): string =>
		event({ choices: [{ index: 0, delta: { tool_calls: [{ index, ...piece }] } }] });
	feed(reader, calls(0, { id: "same", function: { name: "a", arguments: "{}" } }));
	feed(reader, calls(1, { id: "same", function: { name: "b", arguments: "{}" } }));
	feed(reader, calls(2, { id: "call_2", function: { name: "c", arguments: "{}" } }));
	const ended = feed(
		reader,
		event({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
			"data: [DONE]\n\n",
	);

	const calls_ = replyOf(ended).toolCalls;
	expect(calls_.map((call) => call.name)).toEqual(["a", "b", "c"]);
	expect(new Set(calls_.map((call) => call.id)).size).toBe(3);
	expect(calls_[0]?.id).toBe("same");
	// The name it was given does not collide with an id a real call already used.
	expect(calls_[2]?.id).toBe("call_2");
	expect(calls_[1]?.id).not.toBe("call_2");
});

test("OAI09 fields the adapter does not know are ignored", () => {
	const reader = sseReader();
	feed(
		reader,
		event({
			id: "gen-2",
			provider: "OpenAI",
			system_fingerprint: "fp_1",
			choices: [
				{
					index: 0,
					logprobs: { content: [{ token: "hi" }] },
					delta: { role: "assistant", content: "hi", refusal: null, something_new: true },
				},
			],
		}),
	);
	feed(reader, event({ choices: [{ index: 0, delta: {}, finish_reason: "stop", extra: 1 }] }));
	const reply = replyOf(feed(reader, "data: [DONE]\n\ndata: whatever\n\n"));
	expect(reply.text).toBe("hi");
	expect(reply.model).toBe("");
});

describe("OAI10 line endings, comments and multi-line events", () => {
	test("OAI10 CRLF and bare CR split events like a newline", () => {
		const reader = sseReader();
		feed(reader, ": a comment\r\n\r\n");
		feed(
			reader,
			'data: {"choices":[{"index":0,"delta":{"content":"crlf"},"finish_reason":null}]}\r\n\r\n',
		);
		feed(reader, "\r");
		feed(reader, 'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\r\r');
		feed(reader, "data: [DONE]\r\n\r\n");
		expect(replyOf(reader.end()).text).toBe("crlf");
	});

	test("OAI10 one event split over several data lines joins with a newline", () => {
		const reader = sseReader();
		feed(reader, "data: {\n");
		feed(reader, 'data: "choices":[{"index":0,\n');
		feed(reader, 'data: "delta":{"content":"joined"},"finish_reason":"stop"}]}\n');
		feed(reader, "\n");
		expect(replyOf(feed(reader, "data: [DONE]\n\n")).text).toBe("joined");
	});

	test("OAI10 a comment line between events is ignored", () => {
		const reader = sseReader();
		feed(reader, chunk({ content: "kept" }));
		feed(reader, ": OPENROUTER PROCESSING\n\n");
		feed(reader, event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
		expect(replyOf(feed(reader, "data: [DONE]\n\n")).text).toBe("kept");
	});
});

test("OAI11 a stream past the size cap fails and stops being assembled", () => {
	const reader = sseReader({ maxBytes: 400 });
	feed(reader, chunk({ content: "small" }));
	const error = errorOf(feed(reader, chunk({ content: "x".repeat(600) })));
	expect(error.code).toBe("provider_error");
	expect(error.retryable).toBe(false);
	expect(error.message).toContain("400");
	// The reader stays settled: reading on cannot grow the reply.
	expect(errorOf(feed(reader, chunk({ content: "more" }))).code).toBe("provider_error");
	expect(errorOf(reader.end()).code).toBe("provider_error");
});

test("OAI11 the default cap is one MiB", () => {
	expect(DEFAULT_STREAM_CAP_BYTES).toBe(1_048_576);
});

describe("OAI12 a broken chunk", () => {
	test("OAI12 a payload that is not JSON is a retryable error", () => {
		const reader = sseReader();
		const error = errorOf(feed(reader, "data: {not json\n\n"));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("JSON");
	});

	test("OAI12 JSON that is not an object is a retryable error", () => {
		const reader = sseReader();
		expect(errorOf(feed(reader, "data: [1,2,3]\n\n")).code).toBe("provider_error");
		expect(errorOf(feed(reader, "data: null\n\n")).code).toBe("provider_error");
	});

	test("OAI12 a choice that is not an object is a retryable error", () => {
		const reader = sseReader();
		const error = errorOf(feed(reader, event({ choices: [1] })));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
	});
});
