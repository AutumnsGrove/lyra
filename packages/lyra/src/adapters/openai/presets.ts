/**
 * The two providers this adapter speaks (decision 14, docs/adapters.md OAI30).
 *
 * A preset is only configuration: a base URL, the name of the secret that holds
 * the key, and any header the provider asks for. Everything else — the request,
 * the stream, the errors — is the same code, which is the point of speaking one
 * dialect. The key itself is never here: it is read from the Secrets slot by the
 * name a preset gives.
 */

import type { Clock } from "../../core/clock.js";
import type { ModelSlot } from "../../core/model.js";
import type { SecretsSlot } from "../../core/slots.js";
import { createOpenAIChatModel, type FetchLike } from "./model.js";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";

export interface ProviderOptions {
	/** The model id, which a recipe's fallback model overrides (decision 58). */
	model: string;
	secrets: SecretsSlot;
	clock: Clock;
	fetch?: FetchLike;
	headers?: Record<string, string>;
	deadlineMs?: number;
	maxBytes?: number;
}

function build(
	baseUrl: string,
	keyName: string,
	options: ProviderOptions & { extra?: Record<string, string> },
): ModelSlot {
	const headers: Record<string, string> = { ...options.headers, ...options.extra };
	const settings = {
		baseUrl,
		model: options.model,
		secrets: options.secrets,
		keyName,
		clock: options.clock,
		...(Object.keys(headers).length === 0 ? {} : { headers }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
	};
	return createOpenAIChatModel(settings);
}

/** OpenRouter, the primary provider (decision 14). */
export function openRouter(options: ProviderOptions): ModelSlot {
	return build(OPENROUTER_BASE_URL, "OPENROUTER_API_KEY", options);
}

/**
 * OpenCode Go. It asks every client for a stable session header so a conversation
 * keeps its routing and its prompt cache, so one is required rather than
 * optional: a session that changes every call would quietly lose both.
 */
export function openCodeGo(options: ProviderOptions & { session: string }): ModelSlot {
	return build(OPENCODE_GO_BASE_URL, "OPENCODE_GO_API_KEY", {
		...options,
		extra: { "x-opencode-session": options.session },
	});
}
