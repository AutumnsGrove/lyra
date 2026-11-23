import { expect } from "vitest";

import { sseReader } from "../sse.js";

/**
 * The committed cases for OAI13, and the property they hold. Each case is a stream
 * shape a provider, a proxy or a broken model has plausibly sent: a reply cut
 * mid-`data:` line, a `[DONE]` sentinel with no trailing newline, a `\r\n` split
 * across two pieces, a tool call whose argument JSON is only half written.
 *
 * The property lives here so the generator in `sse.fuzz.test.ts` and the replay in
 * `corpus/sse.test.ts` share one definition. The replay is a plain `.test.ts`, so
 * `pnpm test` and the nightly shuffled run both cover it (issue #41).
 */

/** `[the bytes as text, where the stream is fed a piece]`, cuts in character offsets. */
export type SseCase = readonly [string, readonly number[]];

export const cases: Readonly<Record<string, SseCase>> = {
	"a-reply-cut-mid-data-line": [
		'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n',
		[10, 25],
	],
	"a-done-sentinel-with-no-newline": ["data: [DONE]", []],
	"a-carriage-return-split-in-two": ["data: hello\r\n\r\n", [8]],
	"a-comment-only-stream": [": keep-alive\n\n: keep-alive\n\n", []],
	"a-tool-call-whose-arguments-are-half-written": [
		'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"a","arguments":"{"}}]}}]}\n\n',
		[50, 90],
	],
	"an-empty-stream": ["", []],
	"nul-bytes-and-nothing-else": ["\u0000", []],
	"a-line-separator-in-the-data": ["data: {\u2028}", []],
};

/**
 * The property, shared by the generator and the replay: whatever arrives, in
 * however many pieces, the reader returns a reply or an error, never a throw, and
 * never a reply bigger than what it was given.
 */
export function holds([text, cuts]: SseCase): void {
	const reader = sseReader({ maxBytes: 100_000 });
	let position = 0;
	for (const cut of [...cuts, text.length]) {
		if (position >= text.length) {
			break;
		}
		const at = Math.max(position, Math.min(cut, text.length));
		const pushed = reader.push(text.slice(position, at));
		position = at;
		if (!pushed.ok) {
			expect(typeof pushed.error.message).toBe("string");
			expect(pushed.error.code).toBe("provider_error");
			return;
		}
		if (pushed.value !== undefined) {
			// A finished reply is bounded by the bytes that produced it.
			expect(pushed.value.text.length).toBeLessThanOrEqual(text.length + 1);
			return;
		}
	}
	const ended = reader.end();
	if (ended.ok) {
		expect(ended.value.text.length).toBeLessThanOrEqual(text.length + 1);
	} else {
		expect(ended.error.code).toBe("provider_error");
		expect(typeof ended.error.message).toBe("string");
	}
}
