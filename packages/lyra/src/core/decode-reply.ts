/**
 * Decoding what a model sends back (docs/core-loop.md, "Decoding what a model
 * sends back").
 *
 * An adapter builds this value from a wire response, and everything after it —
 * the record, the loop, a viewer — trusts what comes out. So the decoder is
 * tolerant about fields a provider may leave out or rename, strict about a field
 * of the wrong type, and it never throws: the reply is either a `ModelReply` or
 * a `bad_request` naming the field that was wrong.
 */

import type { FinishReason, ModelReply, ToolCall, Usage } from "./model.js";
import { fail, ok, type Result } from "./result.js";

const FINISH_REASONS: readonly FinishReason[] = [
	"stop",
	"length",
	"tool_calls",
	"content_filter",
	"other",
];

/** A plain object, so a list, a null and a primitive are told apart from a record. */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function bad(problem: string): Result<never> {
	return fail("bad_request", `the model reply ${problem}`);
}

function isTokenCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Usage, with a missing count read as zero. A provider that forgets to say is
 * not a reason to fail a run, and a count that is not a count is.
 */
export function decodeUsage(value: unknown): Result<Usage> {
	if (value === undefined) {
		return ok({ inputTokens: 0, outputTokens: 0 });
	}
	if (!isRecord(value)) {
		return bad("has usage that is not an object");
	}
	const inputTokens = value["inputTokens"] === undefined ? 0 : value["inputTokens"];
	const outputTokens = value["outputTokens"] === undefined ? 0 : value["outputTokens"];
	if (!isTokenCount(inputTokens)) {
		return bad("has a usage.inputTokens that is not a count");
	}
	if (!isTokenCount(outputTokens)) {
		return bad("has a usage.outputTokens that is not a count");
	}

	const rawCost = value["cost"];
	if (rawCost === undefined) {
		return ok({ inputTokens, outputTokens });
	}
	if (!isRecord(rawCost)) {
		return bad("has a usage.cost that is not an object");
	}
	const amount = rawCost["amount"];
	if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
		return bad("has a usage.cost.amount that is not a non-negative number");
	}
	if (rawCost["currency"] !== "USD") {
		return bad("has a usage.cost.currency that is not USD");
	}
	const source = rawCost["source"];
	if (source !== "provider" && source !== "allowance" && source !== "catalog") {
		return bad("has a usage.cost.source that is not provider, allowance or catalog");
	}
	return ok({
		inputTokens,
		outputTokens,
		cost: { amount, currency: "USD", source },
	});
}

/**
 * The tool calls of a reply, each with raw argument text. Ids must be unique
 * within a reply: the loop pairs a result to its call by id, so two calls with
 * one id would make the record ambiguous.
 */
export function decodeToolCalls(value: unknown): Result<ToolCall[]> {
	if (value === undefined) {
		return ok([]);
	}
	if (!Array.isArray(value)) {
		return bad("has toolCalls that are not a list");
	}
	const calls: ToolCall[] = [];
	const ids = new Set<string>();
	for (const [index, call] of value.entries()) {
		if (!isRecord(call)) {
			return bad(`has a toolCalls[${index}] that is not an object`);
		}
		const id = call["id"];
		if (typeof id !== "string" || id === "") {
			return bad(`has a toolCalls[${index}].id that is not a non-empty string`);
		}
		if (ids.has(id)) {
			return bad(`has a duplicate tool call id "${id}"`);
		}
		ids.add(id);
		const name = call["name"];
		if (typeof name !== "string" || name === "") {
			return bad(`has a toolCalls[${index}].name that is not a non-empty string`);
		}
		const args = call["arguments"];
		if (typeof args !== "string") {
			return bad(`has a toolCalls[${index}].arguments that are not a string`);
		}
		calls.push({ id, name, arguments: args });
	}
	return ok(calls);
}

/** A reason Lyra does not model is `other`: the run still needs an answer, not a failure. */
function decodeFinishReason(value: unknown): FinishReason {
	return FINISH_REASONS.find((reason) => reason === value) ?? "other";
}

export function decodeReply(value: unknown): Result<ModelReply> {
	if (!isRecord(value)) {
		return bad("is not an object");
	}

	const rawText = value["text"];
	if (rawText !== undefined && typeof rawText !== "string") {
		return bad("has a text that is not a string");
	}
	const text = rawText ?? "";

	const rawReasoning = value["reasoning"];
	if (rawReasoning !== undefined && typeof rawReasoning !== "string") {
		return bad("has a reasoning that is not a string");
	}

	const rawModel = value["model"];
	if (rawModel !== undefined && typeof rawModel !== "string") {
		return bad("has a model that is not a string");
	}
	const model = rawModel ?? "";

	const usage = decodeUsage(value["usage"]);
	if (!usage.ok) {
		return usage;
	}
	const toolCalls = decodeToolCalls(value["toolCalls"]);
	if (!toolCalls.ok) {
		return toolCalls;
	}

	const reply: ModelReply =
		rawReasoning === undefined
			? {
					text,
					toolCalls: toolCalls.value,
					usage: usage.value,
					finishReason: decodeFinishReason(value["finishReason"]),
					model,
				}
			: {
					text,
					reasoning: rawReasoning,
					toolCalls: toolCalls.value,
					usage: usage.value,
					finishReason: decodeFinishReason(value["finishReason"]),
					model,
				};
	return ok(reply);
}
