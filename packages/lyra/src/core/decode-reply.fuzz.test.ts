import fc from "fast-check";
import { expect, test } from "vitest";

import { decodeReply } from "./decode-reply.js";

/**
 * MOD10 in `docs/core-loop.md`. The decoder sits on an adapter's boundary, so it
 * sees whatever a provider, a proxy, or a malicious test sends. The rule is
 * blunt: it returns a reply or a `bad_request`, it never throws, and a reply it
 * accepts always has the shape the type promises.
 */

/** Bytes and shapes from the failure-mode catalog: strings that break JSON, and odd values. */
const nasty = fc.oneof(
	fc.jsonValue(),
	fc.string({ maxLength: 40 }),
	fc.constantFrom("", "null", "{}", "[]", '{"text":}', "\u2028", "\\", "\u0000"),
	fc.record({
		text: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
		toolCalls: fc.oneof(
			fc.array(
				fc.record({
					id: fc.string(),
					name: fc.string(),
					arguments: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
				}),
				{ maxLength: 3 },
			),
			fc.constant("not a list"),
		),
		usage: fc.oneof(
			fc.record({
				inputTokens: fc.oneof(fc.integer(), fc.double(), fc.string()),
				outputTokens: fc.oneof(fc.integer(), fc.double(), fc.string()),
			}),
			fc.constant(null),
		),
		finishReason: fc.oneof(fc.string(), fc.integer(), fc.constant(undefined)),
		model: fc.oneof(fc.string(), fc.integer()),
	}),
);

test("MOD10 any value decodes or is refused, and what it accepts is a reply", () => {
	fc.assert(
		fc.property(nasty, (value) => {
			const result = decodeReply(value);
			if (!result.ok) {
				expect(result.error.code).toBe("bad_request");
				expect(typeof result.error.message).toBe("string");
				return;
			}
			const reply = result.value;
			expect(typeof reply.text).toBe("string");
			expect(typeof reply.model).toBe("string");
			expect(Number.isSafeInteger(reply.usage.inputTokens)).toBe(true);
			expect(reply.usage.inputTokens).toBeGreaterThanOrEqual(0);
			expect(Number.isSafeInteger(reply.usage.outputTokens)).toBe(true);
			expect(reply.usage.outputTokens).toBeGreaterThanOrEqual(0);
			expect(["stop", "length", "tool_calls", "content_filter", "other"]).toContain(
				reply.finishReason,
			);
			expect(Array.isArray(reply.toolCalls)).toBe(true);
			const ids = new Set<string>();
			for (const call of reply.toolCalls) {
				expect(call.id.length).toBeGreaterThan(0);
				expect(call.name.length).toBeGreaterThan(0);
				expect(typeof call.arguments).toBe("string");
				ids.add(call.id);
			}
			expect(ids.size).toBe(reply.toolCalls.length);
		}),
		{ numRuns: 1_000 },
	);
});
