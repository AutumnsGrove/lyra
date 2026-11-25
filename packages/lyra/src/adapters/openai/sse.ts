/**
 * The server-sent-event parser for chat completions (docs/adapters.md, OAI01 to
 * OAI13).
 *
 * A model reply arrives as a stream of `data:` events, each holding one JSON
 * chunk. This file turns that stream into one `ModelReply` without touching the
 * network or the clock, so all of it is testable as a pure function, and the
 * assembled reply goes through the core's `decodeReply` before it leaves. What
 * comes out is a reply the loop already trusts.
 *
 * It is written to be tolerant of everything a provider may leave out and strict
 * about anything that would make the reply a lie: a stream with no ending is an
 * error rather than a short reply, two calls cannot share an id, and a stream
 * that grows past the cap stops being assembled instead of being kept in memory.
 */

import { decodeFinishReason, decodeReply } from "../../core/decode-reply.js";
import { isPlainObject } from "../../core/json.js";
import type { ModelError, ModelReply, ToolCall, Usage } from "../../core/model.js";
import { ok, type Result } from "../../core/result.js";
import { utf8Length } from "../../record/truncate.js";

/** One assembled reply is capped at 1 MiB, the same as a record entry (decision 90). */
export const DEFAULT_STREAM_CAP_BYTES = 1_048_576;

const DONE_MARKER = "[DONE]";

/** Statuses where trying again cannot help, so an in-stream error is not retried. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

export interface SseOptions {
	/** How many bytes of stream to accept before giving up. */
	maxBytes?: number;
	/**
	 * Applied to a provider's own words before they are cut to a message length. A
	 * secret has to come out first: cut first, a secret that straddles the cut is no
	 * longer found by an exact match, and most of it stays in the message.
	 */
	scrub?: (text: string) => string;
}

export interface SseReader {
	/**
	 * Feed the next piece of decoded text. A reply means the stream ended, an error
	 * means it cannot be assembled; `undefined` means keep reading.
	 */
	push(text: string): Result<ModelReply | undefined, ModelError>;
	/** Finish the stream, which fails unless a finish reason or `[DONE]` arrived. */
	end(): Result<ModelReply, ModelError>;
}

type Outcome = { reply: ModelReply } | { error: ModelError };

interface CallState {
	id?: string;
	name: string;
	arguments: string;
}

function providerError(message: string, retryable = true): ModelError {
	return { code: "provider_error", message, retryable };
}

/** A token count, or nothing when the provider did not send one. */
function tokenCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: undefined;
}

/** A cost in credits, which OpenRouter reports in dollars. */
function costAmount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function truncate(text: string): string {
	return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** The next complete line, and how many characters it took, including its ending. */
function nextLine(text: string, atEnd: boolean): { line: string; length: number } | undefined {
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character === "\n") {
			return { line: text.slice(0, index), length: index + 1 };
		}
		if (character === "\r") {
			// A carriage return at the very end of one chunk may be the first half of
			// a CRLF that arrives in the next, so it waits unless the stream is over.
			if (index + 1 < text.length) {
				const width = text[index + 1] === "\n" ? 2 : 1;
				return { line: text.slice(0, index), length: index + width };
			}
			return atEnd ? { line: text.slice(0, index), length: index + 1 } : undefined;
		}
	}
	return undefined;
}

export function sseReader(options: SseOptions = {}): SseReader {
	const maxBytes = options.maxBytes ?? DEFAULT_STREAM_CAP_BYTES;
	const scrub = options.scrub ?? ((text: string): string => text);

	let buffer = "";
	/** The `data:` lines of the event being read. */
	let dataLines: string[] = [];
	let bytes = 0;

	let text = "";
	let reasoning = "";
	const calls = new Map<number, CallState>();
	let inputTokens: number | undefined;
	let outputTokens: number | undefined;
	let cost: number | undefined;
	let finish: string | undefined;
	let model = "";

	let outcome: Outcome | undefined;

	const asPushResult = (settled: Outcome): Result<ModelReply | undefined, ModelError> =>
		"reply" in settled ? ok(settled.reply) : { ok: false, error: settled.error };

	const asEndResult = (settled: Outcome): Result<ModelReply, ModelError> =>
		"reply" in settled ? ok(settled.reply) : { ok: false, error: settled.error };

	const settleError = (error: ModelError): Outcome => {
		const settled: Outcome = { error };
		outcome = settled;
		return settled;
	};

	/** The reply, once it is complete. Everything it claims is checked by the core's decoder. */
	const buildReply = (): ModelReply => {
		const ordered = [...calls.entries()].sort(([left], [right]) => left - right);

		// Ids must be unique within a reply, because the loop pairs a result to its
		// call by id. An id a provider sent for exactly one call is reserved for it,
		// so a synthetic id never takes a real one's place.
		const counts = new Map<string, number>();
		for (const [, state] of ordered) {
			if (state.id !== undefined && state.id !== "") {
				counts.set(state.id, (counts.get(state.id) ?? 0) + 1);
			}
		}
		const reserved = new Set(
			[...counts.entries()].filter(([, count]) => count === 1).map(([id]) => id),
		);

		const used = new Set<string>();
		const toolCalls: ToolCall[] = ordered.map(([, state], position) => {
			const preferred = state.id ?? "";
			let id = preferred;
			// A call with no id, or one repeating an id already taken, gets one from its
			// position, which is stable for a resume. A repeat keeps the first call's.
			if (id === "" || used.has(id)) {
				id = `call_${position + 1}`;
				while (used.has(id) || reserved.has(id)) {
					id = `${id}_`;
				}
			}
			used.add(id);
			return { id, name: state.name, arguments: state.arguments };
		});

		const usage: Usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0 };
		if (cost !== undefined) {
			usage.cost = { amount: cost, currency: "USD", source: "provider" };
		}

		const reply: ModelReply = {
			text,
			toolCalls,
			usage,
			finishReason: decodeFinishReason(finish),
			model,
		};
		if (reasoning !== "") {
			reply.reasoning = reasoning;
		}
		return reply;
	};

	const settleReply = (): Outcome => {
		const decoded = decodeReply(buildReply());
		if (!decoded.ok) {
			// The assembled reply is not one the loop could act on. Trying again with
			// the same model would send the same broken thing, so this is not retryable.
			return settleError({
				code: "provider_error",
				message: decoded.error.message,
				retryable: false,
			});
		}
		const settled: Outcome = { reply: decoded.value };
		outcome = settled;
		return settled;
	};

	const applyDelta = (delta: Record<string, unknown>): ModelError | undefined => {
		const content = delta["content"];
		if (typeof content === "string" && content !== "") {
			text += content;
		}
		// OpenRouter calls it `reasoning`; other OpenAI-style endpoints use `reasoning_content`.
		const reasoningPiece = delta["reasoning"] ?? delta["reasoning_content"];
		if (typeof reasoningPiece === "string" && reasoningPiece !== "") {
			reasoning += reasoningPiece;
		}

		const rawCalls = delta["tool_calls"];
		if (rawCalls === undefined) {
			return undefined;
		}
		if (!Array.isArray(rawCalls)) {
			return providerError("the model's stream sent tool_calls that are not a list");
		}
		for (const [position, rawCall] of rawCalls.entries()) {
			if (!isPlainObject(rawCall)) {
				return providerError("the model's stream sent a tool call that is not an object");
			}
			const rawIndex = rawCall["index"];
			const index =
				typeof rawIndex === "number" && Number.isSafeInteger(rawIndex) && rawIndex >= 0
					? rawIndex
					: position;
			const state = calls.get(index) ?? { name: "", arguments: "" };
			const id = rawCall["id"];
			if (typeof id === "string" && id !== "") {
				state.id = id;
			}
			const name = rawCall["function"];
			if (isPlainObject(name)) {
				// The name arrives once; the arguments arrive in as many pieces as the
				// provider likes, and their exact text is what the model meant to send.
				const rawName = name["name"];
				if (typeof rawName === "string" && rawName !== "" && state.name === "") {
					state.name = rawName;
				}
				const rawArguments = name["arguments"];
				if (typeof rawArguments === "string") {
					state.arguments += rawArguments;
				}
			}
			calls.set(index, state);
		}
		return undefined;
	};

	const applyUsage = (rawUsage: Record<string, unknown>): void => {
		const prompt = tokenCount(rawUsage["prompt_tokens"]);
		if (prompt !== undefined) {
			inputTokens = prompt;
		}
		const completion = tokenCount(rawUsage["completion_tokens"]);
		if (completion !== undefined) {
			outputTokens = completion;
		}
		const reported = costAmount(rawUsage["cost"]);
		if (reported !== undefined) {
			cost = reported;
		}
	};

	const handlePayload = (payload: string): void => {
		if (payload.trim() === DONE_MARKER) {
			// `[DONE]` is the provider saying the stream is over, so it is an ending in
			// its own right: a compatible endpoint may send it without a finish reason,
			// and the core already turns a reason it does not model into `other`.
			settleReply();
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			settleError(providerError("the model's stream sent a chunk that is not JSON"));
			return;
		}
		if (!isPlainObject(parsed)) {
			settleError(providerError("the model's stream sent a chunk that is not an object"));
			return;
		}

		// A provider that fails in the middle of a stream sends the failure as a
		// chunk with an HTTP status inside it, because the status line already went.
		const rawError = parsed["error"];
		if (isPlainObject(rawError)) {
			const status = typeof rawError["code"] === "number" ? rawError["code"] : 0;
			const message =
				typeof rawError["message"] === "string"
					? rawError["message"]
					: "the model's provider reported an error";
			settleError({
				code: "provider_error",
				message: truncate(scrub(message)),
				retryable: !PERMANENT_STATUSES.has(status),
			});
			return;
		}

		const rawModel = parsed["model"];
		if (typeof rawModel === "string") {
			model = rawModel;
		}
		const rawUsage = parsed["usage"];
		if (isPlainObject(rawUsage)) {
			applyUsage(rawUsage);
		}

		const choices = parsed["choices"];
		if (choices === undefined) {
			return;
		}
		if (!Array.isArray(choices)) {
			settleError(providerError("the model's stream sent choices that are not a list"));
			return;
		}
		for (const choice of choices) {
			if (!isPlainObject(choice)) {
				settleError(
					providerError("the model's stream sent a choice that is not an object"),
				);
				return;
			}
			// One completion was asked for, so a choice for another index says nothing.
			const index = choice["index"];
			if (typeof index === "number" && index !== 0) {
				continue;
			}
			const rawFinish = choice["finish_reason"];
			if (typeof rawFinish === "string" && rawFinish !== "" && rawFinish !== "error") {
				finish = rawFinish;
			}
			const delta = choice["delta"];
			if (isPlainObject(delta)) {
				const problem = applyDelta(delta);
				if (problem !== undefined) {
					settleError(problem);
					return;
				}
			}
		}
	};

	const handleLine = (line: string): void => {
		if (line === "") {
			// A blank line is the end of the event, which is where its data is read.
			if (dataLines.length === 0) {
				return;
			}
			const payload = dataLines.join("\n");
			dataLines = [];
			handlePayload(payload);
			return;
		}
		if (line.startsWith(":")) {
			// A comment, which OpenRouter sends as a keep-alive.
			return;
		}
		const colon = line.indexOf(":");
		const field = colon === -1 ? line : line.slice(0, colon);
		if (field === "data") {
			const value = colon === -1 ? "" : line.slice(colon + 1);
			dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
		}
		// `event:`, `id:` and `retry:` carry nothing a chat completion needs.
	};

	return {
		push(chunk) {
			if (outcome !== undefined) {
				return asPushResult(outcome);
			}
			bytes += utf8Length(chunk);
			if (bytes > maxBytes) {
				return asPushResult(
					settleError(
						providerError(
							`the model's stream passed ${maxBytes} bytes, so it was given up on`,
							false,
						),
					),
				);
			}
			buffer += chunk;
			for (;;) {
				const found = nextLine(buffer, false);
				if (found === undefined) {
					return ok(undefined);
				}
				buffer = buffer.slice(found.length);
				handleLine(found.line);
				if (outcome !== undefined) {
					return asPushResult(outcome);
				}
			}
		},

		end() {
			if (outcome !== undefined) {
				return asEndResult(outcome);
			}
			if (buffer.trim() !== "" || dataLines.length > 0) {
				return asEndResult(
					settleError(
						providerError("the model's stream ended in the middle of an event"),
					),
				);
			}
			if (finish === undefined) {
				return asEndResult(
					settleError(providerError("the model's stream ended without a finish reason")),
				);
			}
			return asEndResult(settleReply());
		},
	};
}

export interface ReadReplyOptions extends SseOptions {
	/** The caller's signal, so a stop that arrives mid-read is not read as a network fault. */
	signal?: AbortSignal;
}

/** A promise that rejects the moment a stop is signalled, so a read cannot hang through one. */
function abortPromise(signal: AbortSignal): Promise<never> {
	return new Promise<never>((_, reject) => {
		const stop = (): void => reject(providerError("the model's reply stopped", false));
		if (signal.aborted) {
			stop();
			return;
		}
		signal.addEventListener("abort", stop, { once: true });
	});
}

function reasonOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Read a body to one reply, decoding bytes as they arrive. The stream is always
 * closed when this returns, whether it ended, failed or was refused, so a
 * provider is never left sending into a reader nobody holds.
 */
export async function readReply(
	body: ReadableStream<Uint8Array> | null,
	options: ReadReplyOptions = {},
): Promise<Result<ModelReply, ModelError>> {
	if (body === null) {
		return { ok: false, error: providerError("the model's response had no body") };
	}
	const stream = body.getReader();
	const decoder = new TextDecoder();
	const reader = sseReader(options);
	const stop = options.signal === undefined ? undefined : abortPromise(options.signal);

	const push = (text: string): Result<ModelReply, ModelError> | undefined => {
		const pushed = reader.push(text);
		if (!pushed.ok) {
			return pushed;
		}
		return pushed.value === undefined ? undefined : ok(pushed.value);
	};

	try {
		for (;;) {
			const read =
				stop === undefined
					? await stream.read()
					: await Promise.race([stream.read(), stop]);
			if (read.done) {
				break;
			}
			if (read.value === undefined) {
				continue;
			}
			const settled = push(decoder.decode(read.value, { stream: true }));
			if (settled !== undefined) {
				return settled;
			}
		}
		const tail = decoder.decode();
		if (tail !== "") {
			const settled = push(tail);
			if (settled !== undefined) {
				return settled;
			}
		}
		return reader.end();
	} catch (error) {
		return {
			ok: false,
			error: providerError(`the model's reply stopped: ${reasonOf(error)}`),
		};
	} finally {
		// Closing a stream that already ended is harmless, and it releases one that
		// was given up on early.
		void stream.cancel().catch(() => undefined);
	}
}
