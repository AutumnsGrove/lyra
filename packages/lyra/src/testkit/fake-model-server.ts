/**
 * The fake model server (docs/engineering-practices.md, KIT09 to KIT11).
 *
 * It is `fetch`, not a socket. The adapter takes an injectable `fetch`, so a
 * server that is a function proves everything a real one would except a genuine
 * TCP failure, and those are simulated the way the platform produces them: a
 * `fetch` that rejects, and a body that errors while it is being read. A socket
 * would need `node:net`, which `importcheck` refuses everywhere under `src/`,
 * and it would test the runtime's networking rather than Lyra.
 *
 * The scripts are the same `ScriptedTurn`s the in-process scripted model reads,
 * so one scenario can run either way. What differs is the wire: here a turn
 * becomes real server-sent-event bytes, with the text split across chunks and
 * each tool call's name in one and its arguments in the next, which is what a
 * provider actually sends.
 */

import { isPlainObject } from "../core/json.js";
import { scriptedArguments, type ScriptedTurn } from "./model.js";

/** One request the server saw, kept so a test can assert what the adapter sent. */
export interface FakeModelRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	/** The parsed JSON body, or the raw text when it was not JSON. */
	body: unknown;
}

/**
 * How the server misbehaves on one request (the failure-mode catalog's list). A
 * request with no fault at its position answers the script.
 */
export type FakeModelFault =
	| { kind: "status"; status: number; retryAfter?: string; body?: string }
	| { kind: "cut" }
	| { kind: "malformed" }
	| { kind: "stall" }
	| { kind: "error-body"; message?: string }
	| { kind: "non-json" }
	| { kind: "mid-stream-error"; status?: number; message?: string }
	| { kind: "body-error"; message?: string }
	| { kind: "huge"; bytes?: number }
	/** A test that needs a stream the named faults cannot make. */
	| { kind: "custom"; answer(): Response | Promise<Response> };

export interface FakeModelServerOptions {
	/** The name a reply reports. Defaults to `scripted/model`. */
	model?: string;
	/** One fault per request, by the request's position; a hole answers the script. */
	faults?: (FakeModelFault | undefined)[];
}

/**
 * What `fetch` is called with, spelled out here rather than named from
 * `platform.d.ts`: the testkit is imported by the workerd program too, which
 * gets its globals from the Workers types instead.
 */
export interface FakeFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

export interface FakeModelServer {
	(options: string, init?: FakeFetchInit): Promise<Response>;
	/** Every request received, in order. */
	requests: FakeModelRequest[];
}

function abortError(): Error {
	const error = new Error("the request was aborted");
	error.name = "AbortError";
	return error;
}

function payload(chunk: unknown): string {
	return `data: ${JSON.stringify(chunk)}\n\n`;
}

function chunkOf(model: string, delta: unknown): string {
	return payload({
		id: "gen-fake",
		object: "chat.completion.chunk",
		created: 0,
		model,
		choices: [{ index: 0, delta, finish_reason: null }],
	});
}

/** A scripted turn as the bytes a provider would send for it. */
export function sseFor(turn: ScriptedTurn, model: string): string {
	const pieces: string[] = [];
	if (turn.reasoning !== undefined && turn.reasoning !== "") {
		pieces.push(chunkOf(model, { role: "assistant", reasoning: turn.reasoning }));
	}
	const text = turn.text ?? "";
	if (text !== "") {
		// Half now and half in the next chunk, because that is how text arrives.
		const half = Math.floor(text.length / 2);
		pieces.push(chunkOf(model, { content: text.slice(0, half) }));
		pieces.push(chunkOf(model, { content: text.slice(half) }));
	}
	const calls = turn.toolCalls ?? [];
	for (const [index, call] of calls.entries()) {
		pieces.push(
			chunkOf(model, {
				tool_calls: [
					{ index, id: call.id, type: "function", function: { name: call.name } },
				],
			}),
		);
		pieces.push(
			chunkOf(model, {
				tool_calls: [{ index, function: { arguments: scriptedArguments(call.args) } }],
			}),
		);
	}
	const finish = turn.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop");
	pieces.push(
		payload({
			id: "gen-fake",
			model,
			choices: [{ index: 0, delta: {}, finish_reason: finish }],
		}),
	);
	const usage = turn.usage ?? { inputTokens: 0, outputTokens: 0 };
	const reported: Record<string, unknown> = {
		prompt_tokens: usage.inputTokens,
		completion_tokens: usage.outputTokens,
	};
	if (usage.cost !== undefined) {
		reported["cost"] = usage.cost.amount;
	}
	pieces.push(payload({ id: "gen-fake", model, choices: [], usage: reported }));
	pieces.push("data: [DONE]\n\n");
	return pieces.join("");
}

function streamOf(pieces: readonly string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const piece of pieces) {
				controller.enqueue(encoder.encode(piece));
			}
			controller.close();
		},
	});
}

function streamed(text: string): Response {
	return new Response(streamOf([text]), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** A stream that fails while it is being read, which a dropped connection does. */
function broken(message: string): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(chunkOf("scripted/model", { content: "part" })));
				controller.error(new Error(message));
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

/** A request that is never answered, which is what the adapter's deadline is for. */
function stall(signal: AbortSignal | undefined): Promise<Response> {
	return new Promise<Response>((_, reject) => {
		if (signal === undefined) {
			return;
		}
		const stop = (): void => reject(abortError());
		if (signal.aborted) {
			stop();
			return;
		}
		signal.addEventListener("abort", stop, { once: true });
	});
}

function answer(
	fault: FakeModelFault,
	signal: AbortSignal | undefined,
): Promise<Response> | Response {
	switch (fault.kind) {
		case "status": {
			const headers: Record<string, string> = {};
			if (fault.retryAfter !== undefined) {
				headers["retry-after"] = fault.retryAfter;
			}
			if (typeof fault.body === "string") {
				// A body that is not JSON is what a proxy in front of a provider sends.
				return new Response(fault.body, { status: fault.status, headers });
			}
			return json(
				fault.body ?? { error: { message: `the fake server answered ${fault.status}` } },
				fault.status,
				headers,
			);
		}
		case "cut":
			return streamed('data: {"choices":[{"index":0,"delta":{"content":"half a rep');
		case "malformed":
			return streamed("data: {not json at all\n\n");
		case "stall":
			return stall(signal);
		case "error-body":
			return json(
				{ error: { message: fault.message ?? "the model could not be reached" } },
				200,
			);
		case "non-json":
			return new Response("<html>bad gateway</html>", {
				status: 500,
				headers: { "content-type": "text/html" },
			});
		case "mid-stream-error":
			return streamed(
				chunkOf("scripted/model", { content: "part" }) +
					payload({
						id: "gen-fake",
						model: "scripted/model",
						error: {
							code: fault.status ?? 429,
							message: fault.message ?? "the provider gave up",
						},
						choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
					}),
			);
		case "body-error":
			return broken(fault.message ?? "the connection was reset");
		case "huge":
			return streamed(
				chunkOf("scripted/model", { content: "x".repeat(fault.bytes ?? 1_200_000) }) +
					chunkOf("scripted/model", { content: "end" }) +
					"data: [DONE]\n\n",
			);
		case "custom":
			return fault.answer();
	}
}

function assistantMessages(body: unknown): number {
	if (!isPlainObject(body)) {
		return 0;
	}
	const messages = body["messages"];
	if (!Array.isArray(messages)) {
		return 0;
	}
	return messages.filter((message) => isPlainObject(message) && message["role"] === "assistant")
		.length;
}

function parseBody(body: string | undefined): unknown {
	if (body === undefined) {
		return undefined;
	}
	try {
		return JSON.parse(body);
	} catch {
		return body;
	}
}

export function fakeModelServer(
	turns: readonly ScriptedTurn[],
	options: FakeModelServerOptions = {},
): FakeModelServer {
	const model = options.model ?? "scripted/model";
	const faults = [...(options.faults ?? [])];
	const requests: FakeModelRequest[] = [];

	const serve = async (url: string, init?: FakeFetchInit): Promise<Response> => {
		const position = requests.length;
		const body = parseBody(init?.body);
		requests.push({
			url,
			method: init?.method ?? "GET",
			headers: { ...init?.headers },
			body,
		});

		const fault = faults[position];
		if (fault !== undefined) {
			return answer(fault, init?.signal);
		}

		// The reply comes from the turn whose position matches the assistant messages
		// already in the request, exactly as the in-process scripted model does.
		const turn = turns[assistantMessages(body)];
		if (turn === undefined) {
			return json(
				{
					error: {
						message: `the fake server has no turn ${assistantMessages(body) + 1}`,
					},
				},
				500,
			);
		}
		return streamed(sseFor(turn, model));
	};

	return Object.assign(serve, { requests });
}
