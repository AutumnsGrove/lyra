import fc from "fast-check";
import { expect, test } from "vitest";

import { generate } from "../../testkit/corpus.testing.js";
import { holds } from "./corpus/sse.testing.js";
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
	generate("sse", fc.tuple(nasty, cuts), holds, { numRuns: 400 });
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
