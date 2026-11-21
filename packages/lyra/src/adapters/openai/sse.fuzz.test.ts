import fc from "fast-check";
import { expect, test } from "vitest";

import { sseReader } from "./sse.js";

/**
 * OAI13 in `docs/adapters.md`. The stream parser is the first thing a provider's
 * bytes reach, and a proxy, a broken model or an attacker can send anything at
 * all. The rule is blunt: whatever arrives, in however many pieces, the reader
 * returns a reply or an error, never a throw, and never a reply bigger than what
 * it was given.
 */

/** Bytes that break JSON, break lines, or pretend to be SSE framing. */
const nasty = fc.oneof(
	fc.string({ maxLength: 200 }),
	fc.constantFrom(
		"",
		"data:",
		"data: ",
		"data: [DONE]",
		"\n\n",
		"\r\n\r\n",
		"\r",
		": comment",
		'data: {"choices":[{"index":0,"delta":{"content":"x"}}]}',
		'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"a","arguments":"{"}}]}}]}',
		"data: {\u2028}",
		"data: null",
		"\u0000",
	),
	fc.array(fc.string({ maxLength: 30 }), { maxLength: 20 }).map((parts) => parts.join("\n")),
);

/** Where a network might cut the stream, in order and never past the end. */
const cuts = fc
	.array(fc.nat({ max: 60 }), { maxLength: 12 })
	.map((cuts) => [...cuts].sort((a, b) => a - b));

test("OAI13 any bytes in any pieces give a reply or an error, never a throw", () => {
	fc.assert(
		fc.property(nasty, cuts, (text, cuts) => {
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
		}),
		{ numRuns: 400 },
	);
});

test("OAI13 a stream past the cap is refused rather than assembled", () => {
	const text = fc.sample(fc.string({ minLength: 200, maxLength: 400 }), 1)[0] ?? "";
	const reader = sseReader({ maxBytes: 64 });
	const pushed = reader.push(text);
	const ended = reader.end();
	// Neither half may hand back a reply: the cap is the answer.
	expect(pushed.ok).toBe(false);
	expect(ended.ok).toBe(false);
});
