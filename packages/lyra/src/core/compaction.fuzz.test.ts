import fc from "fast-check";
import { expect, test } from "vitest";

import { generate } from "../testkit/corpus.testing.js";
import type { RecordEntry } from "../record/entries.js";
import { entryTokens, estimateTokens } from "./compaction.js";
import { hostileEntryArbitrary } from "./compaction-generators.testing.js";
import { holds } from "./corpus/compaction.testing.js";

/**
 * CMP02 and CMP05 in `docs/context-size.md` over hostile text: a record's content
 * is whatever a model and a tool wrote, so the cut is asked to work on strings
 * with lone surrogates, control characters and megabytes of noise, and must
 * answer rather than throw. Seeds print on failure (fast-check's own default).
 */
test("CMP02 chooseCut never throws on hostile content and still starts a whole step", () => {
	generate(
		"compaction",
		fc.tuple(fc.array(hostileEntryArbitrary(), { maxLength: 6 }), fc.nat({ max: 5_000 })),
		holds,
		{ numRuns: 400 },
	);
});

test("the estimate is always a safe non-negative integer", () => {
	fc.assert(
		fc.property(fc.string({ maxLength: 5_000 }), (text) => {
			const tokens = estimateTokens(text);
			expect(Number.isSafeInteger(tokens)).toBe(true);
			expect(tokens).toBeGreaterThanOrEqual(0);
			expect(tokens).toBe(Math.ceil(text.length / 4));
		}),
		{ numRuns: 300 },
	);
});

test("every entry kind has a finite cost", () => {
	fc.assert(
		fc.property(fc.array(hostileEntryArbitrary(), { maxLength: 4 }), (entries) => {
			for (const entry of entries) {
				expect(Number.isSafeInteger(entryTokens(entry))).toBe(true);
			}
		}),
		{ numRuns: 100 },
	);
});
