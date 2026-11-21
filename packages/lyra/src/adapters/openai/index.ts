/**
 * The OpenAI-style model adapter (decision 14, step 5).
 *
 * One adapter for chat completions, pointed at OpenRouter or OpenCode Go by
 * configuration. The core never imports this, and this imports the core and
 * nothing else: `fetch`, `ReadableStream`, `TextDecoder` and `AbortSignal` are
 * all web-standard, so it runs on Workers and on Node from the same code.
 *
 * The slot is `createOpenAIChatModel`. It reads its key from a Secrets slot on
 * every call, streams one reply, and maps every failure onto the core's
 * `ModelError` so step 2's retries can trust it.
 */

export { DEFAULT_DEADLINE_MS, createOpenAIChatModel, type OpenAIChatOptions } from "./model.js";
export {
	OPENCODE_GO_BASE_URL,
	OPENROUTER_BASE_URL,
	openCodeGo,
	openRouter,
	type ProviderOptions,
} from "./presets.js";
export {
	MAX_MESSAGE_CHARS,
	MAX_RETRY_AFTER_MS,
	codeForStatus,
	errorForStatus,
	errorFromJsonBody,
	isRetryableStatus,
	retryAfterMs,
	truncateMessage,
} from "./errors.js";
export { buildHeaders, buildWireRequest, type HeaderOptions, type WireBody } from "./request.js";
export {
	DEFAULT_STREAM_CAP_BYTES,
	readReply,
	sseReader,
	type ReadReplyOptions,
	type SseOptions,
	type SseReader,
} from "./sse.js";
