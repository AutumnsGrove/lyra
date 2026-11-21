/**
 * The OpenAI-style model adapter (decision 14, step 5).
 *
 * One adapter for chat completions, pointed at OpenRouter or OpenCode Go by
 * configuration. The core never imports this, and this imports the core and
 * nothing else: `fetch`, `ReadableStream`, `TextDecoder` and `AbortSignal` are
 * all web-standard, so it runs on Workers and on Node from the same code.
 *
 * What is here so far is the parser, which turns a provider's server-sent events
 * into one reply, and the request builder, which turns the slot's request into a
 * chat-completions body and its headers. The slot itself and its error mapping
 * arrive next.
 */

export { buildHeaders, buildWireRequest, type HeaderOptions, type WireBody } from "./request.js";
export { DEFAULT_STREAM_CAP_BYTES, sseReader, type SseOptions, type SseReader } from "./sse.js";
