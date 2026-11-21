/**
 * The request on the wire (docs/adapters.md, OAI14 to OAI19).
 *
 * The Model slot's request is generic — a system prompt, messages, tools, a
 * signal — and chat completions wants the same things spelled its own way. This
 * file is that translation and nothing else: it is pure, so a test can read the
 * whole of what would be sent without a socket.
 *
 * Two properties matter more than the mapping. Nothing is sent that a model might
 * reject: no `tool_choice`, no `stream_options`, no usage switch, no provider
 * field, because the core has no way to ask for one and both endpoints answer
 * without them. And the key exists in exactly one place, the `Authorization`
 * header, built from what a host's Secrets slot gave rather than from anything
 * that could be logged or recorded.
 */

import type { ConversationMessage } from "../../core/conversation.js";
import type { JsonValue } from "../../core/json.js";
import type { ModelRequest } from "../../core/model.js";

/** One chat-completions request body, as the endpoint takes it. */
export interface WireBody {
	model: string;
	stream: true;
	messages: JsonValue[];
	tools?: JsonValue[];
}

function wireMessage(message: ConversationMessage): JsonValue {
	switch (message.role) {
		case "user":
			return { role: "user", content: message.text };
		case "assistant":
			// A reply with no calls is text alone, which is what a provider sends back
			// as its own last turn. Reasoning is kept in the record (decision 33) but is
			// never sent back: chat completions has no field for it.
			if (message.toolCalls.length === 0) {
				return { role: "assistant", content: message.text };
			}
			return {
				role: "assistant",
				content: message.text,
				tool_calls: message.toolCalls.map((call) => ({
					id: call.id,
					type: "function",
					function: { name: call.name, arguments: call.arguments },
				})),
			};
		case "tool":
			// Chat completions has no error field, and the loop already said what went
			// wrong in the content, so `isError` is not invented on the wire.
			return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
	}
}

/**
 * The body for one request. `configured` is the adapter's model, which a recipe's
 * fallback model overrides (decision 58).
 */
export function buildWireRequest(options: { request: ModelRequest; model: string }): WireBody {
	const { request } = options;
	const messages: JsonValue[] = [];
	if (request.system !== "") {
		messages.push({ role: "system", content: request.system });
	}
	for (const message of request.messages) {
		messages.push(wireMessage(message));
	}

	const body: WireBody = {
		model: request.model ?? options.model,
		stream: true,
		messages,
	};
	if (request.tools.length > 0) {
		body.tools = request.tools.map((tool) => ({
			type: "function",
			function: {
				name: tool.name,
				description: tool.description,
				parameters: tool.parameters,
			},
		}));
	}
	return body;
}

export interface HeaderOptions {
	/** The key, read from a host's Secrets slot by the adapter and never held here. */
	apiKey: string;
	/** A stable session id, which OpenCode Go asks for so it can route and cache. */
	session?: string;
	/** A preset's own headers. None of them can replace the computed ones below. */
	extra?: Record<string, string>;
}

/**
 * The headers for one request. A preset's own headers go on first and the
 * computed ones last, so nothing can replace the key or the content type by
 * accident.
 */
export function buildHeaders(options: HeaderOptions): Record<string, string> {
	const headers: Record<string, string> = { ...options.extra };
	headers["content-type"] = "application/json";
	headers["accept"] = "text/event-stream";
	headers["authorization"] = `Bearer ${options.apiKey}`;
	if (options.session !== undefined) {
		headers["x-opencode-session"] = options.session;
	}
	return headers;
}
