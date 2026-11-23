import fc from "fast-check";
import { expect, test } from "vitest";

import { generate } from "../testkit/corpus.testing.js";
import { entriesArbitrary, headerArbitrary } from "./generators.testing.js";
import { holds } from "./corpus/load.testing.js";

/**
 * RCD07 in `docs/run-record.md`. The loader is the one place a file written by
 * anything at all is read: an eviction cut it in half, an older writer left a
 * kind this build does not know, or a host wrote nonsense. It must always
 * return, and it must never lose a line it could read.
 */
test("RCD07 hostile lines never throw and never lose a valid one", () => {
	const junk = fc.oneof(
		fc.string({ maxLength: 40 }),
		fc.jsonValue().map((value) => JSON.stringify(value)),
		fc.constantFrom("", "{", "null", "[]", "\u2028", '{"type":'),
	);

	generate(
		"load",
		fc
			.tuple(headerArbitrary(), entriesArbitrary(), fc.array(junk, { maxLength: 5 }))
			.map(([, entries, rawJunk]) => ({ entries, junk: rawJunk })),
		holds,
		{ numRuns: 300 },
	);
});
