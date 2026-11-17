import { describe, expect, test } from "vitest";

import { decodeReply } from "./decode-reply.js";
import type { ModelReply } from "./model.js";

/** Rows are in `docs/core-loop.md`. */

function accepted(value: unknown): ModelReply {
	const result = decodeReply(value);
	if (!result.ok) {
		throw new Error(`expected a reply, got ${result.error.code}: ${result.error.message}`);
	}
	return result.value;
}

function rejected(value: unknown): { code: string; message: string } {
	const result = decodeReply(value);
	if (result.ok) {
		throw new Error(`expected a refusal, got ${JSON.stringify(result.value)}`);
	}
	return result.error;
}

const full = {
	text: "I will read the issue, then finish.",
	reasoning: "Two calls because the second needs the first.",
	toolCalls: [
		{ id: "c1", name: "read_issue", arguments: '{"number":12}' },
		{ id: "c2", name: "finish", arguments: "{}" },
	],
	usage: {
		inputTokens: 120,
		outputTokens: 40,
		cost: { amount: 0.0004, currency: "USD", source: "provider" },
	},
	finishReason: "tool_calls",
	model: "some/model",
};

describe("a whole reply", () => {
	test("MOD01 decodes text, tool calls, usage, a finish reason and a model", () => {
		expect(accepted(full)).toEqual(full);
	});

	test("MOD02 keeps a length finish reason and its tool calls", () => {
		const cut = {
			...full,
			finishReason: "length",
			text: "I was saying that the",
			toolCalls: [{ id: "c9", name: "read_issue", arguments: '{"number":1' }],
		};
		const reply = accepted(cut);
		expect(reply.finishReason).toBe("length");
		expect(reply.toolCalls).toHaveLength(1);
		// The half-written arguments survive as text: rejecting them here would hide
		// the fact the model was cut off, which the loop has to act on.
		expect(reply.toolCalls[0]?.arguments).toBe('{"number":1');
	});
});

describe("what a provider may leave out", () => {
	test("MOD03 a missing or unknown finish reason becomes other", () => {
		expect(accepted({}).finishReason).toBe("other");
		expect(accepted({ finishReason: "invented_by_a_proxy" }).finishReason).toBe("other");
		expect(accepted({ finishReason: 7 }).finishReason).toBe("other");
	});

	test("MOD03 missing usage is zero tokens and no cost", () => {
		expect(accepted({}).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
		expect(accepted({ usage: {} }).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	test("MOD03 missing text, model and tool calls are empty, and extra fields are ignored", () => {
		const reply = accepted({
			provider_metadata: { trace: "abc" },
			text_alias: "not text",
		});
		expect(reply).toEqual({
			text: "",
			toolCalls: [],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "other",
			model: "",
		});
	});
});

describe("a tool call that is malformed", () => {
	test("MOD04 rejects a missing or empty id", () => {
		expect(rejected({ toolCalls: [{ name: "finish", arguments: "{}" }] }).message).toMatch(
			/toolCalls\[0\]\.id/,
		);
		expect(rejected({ toolCalls: [{ id: "", name: "finish", arguments: "{}" }] }).code).toBe(
			"bad_request",
		);
	});

	test("MOD04 rejects an empty name", () => {
		expect(rejected({ toolCalls: [{ id: "c1", name: "", arguments: "{}" }] }).message).toMatch(
			/toolCalls\[0\]\.name/,
		);
	});

	test("MOD04 rejects two calls with the same id", () => {
		const duplicated = [
			{ id: "c1", name: "a", arguments: "{}" },
			{ id: "c1", name: "b", arguments: "{}" },
		];
		expect(rejected({ toolCalls: duplicated }).message).toMatch(/duplicate/i);
	});

	test("MOD04 rejects arguments that are not a string, and a call that is not an object", () => {
		expect(
			rejected({ toolCalls: [{ id: "c1", name: "a", arguments: { number: 1 } }] }).message,
		).toMatch(/toolCalls\[0\]\.arguments/);
		expect(rejected({ toolCalls: ["c1"] }).message).toMatch(/toolCalls\[0\]/);
	});

	test("MOD04 rejects toolCalls that is not a list", () => {
		expect(rejected({ toolCalls: { id: "c1" } }).message).toMatch(/toolCalls/);
	});
});

describe("a number that is not a count", () => {
	test("MOD05 rejects a negative, fractional, infinite or non-numeric token count", () => {
		for (const usage of [
			{ inputTokens: -1, outputTokens: 0 },
			{ inputTokens: 0, outputTokens: -1 },
			{ inputTokens: 1.5, outputTokens: 0 },
			{ inputTokens: Number.POSITIVE_INFINITY, outputTokens: 0 },
			{ inputTokens: "12", outputTokens: 0 },
			{ inputTokens: null, outputTokens: 0 },
		]) {
			expect(rejected({ usage }).code).toBe("bad_request");
		}
		// A usage that is not an object at all is the same failure.
		expect(rejected({ usage: "12" }).code).toBe("bad_request");
	});
});

describe("a value that is not a reply", () => {
	test("MOD06 rejects null, a list, a string, a number and a boolean", () => {
		for (const value of [null, [], "reply", 7, true]) {
			expect(rejected(value).code).toBe("bad_request");
		}
	});

	test("MOD07 rejects text or reasoning of the wrong type, and accepts them absent", () => {
		expect(rejected({ text: 12 }).message).toMatch(/text/);
		expect(rejected({ reasoning: ["why"] }).message).toMatch(/reasoning/);
		expect(accepted({ text: undefined }).text).toBe("");
		expect(accepted({ reasoning: undefined })).not.toHaveProperty("reasoning");
	});

	test("MOD08 rejects a model name of the wrong type, and defaults it to empty", () => {
		expect(rejected({ model: 42 }).message).toMatch(/model/);
		expect(accepted({}).model).toBe("");
	});

	test("MOD09 rejects a cost with a bad amount, currency or source", () => {
		const usage = { inputTokens: 1, outputTokens: 1 };
		expect(
			rejected({
				usage: { ...usage, cost: { amount: -1, currency: "USD", source: "provider" } },
			}).code,
		).toBe("bad_request");
		expect(
			rejected({
				usage: { ...usage, cost: { amount: 1, currency: "EUR", source: "provider" } },
			}).code,
		).toBe("bad_request");
		expect(
			rejected({
				usage: { ...usage, cost: { amount: 1, currency: "USD", source: "guessed" } },
			}).code,
		).toBe("bad_request");
		// A cost that is not an object at all is the same failure.
		expect(rejected({ usage: { ...usage, cost: 1 } }).code).toBe("bad_request");
	});
});
