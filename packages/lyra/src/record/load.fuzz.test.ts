import fc from "fast-check";
import { expect, test } from "vitest";

import { isPlainObject } from "../core/json.js";
import { encodeEntry, encodeHeader } from "./entries.js";
import { entriesArbitrary, headerArbitrary } from "./generators.testing.js";
import { loadRecord } from "./load.js";

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

	fc.assert(
		fc.property(
			headerArbitrary(),
			entriesArbitrary(),
			fc.array(junk, { maxLength: 5 }),
			(head, entries, rawJunk) => {
				// Lines that could be an entry of their own are left out, so the only
				// entries in the record are the ones this test put there.
				const noise = rawJunk.filter((line) => {
					try {
						const parsed: unknown = JSON.parse(line);
						return !isPlainObject(parsed) || typeof parsed["type"] !== "string";
					} catch {
						return true;
					}
				});

				const input = [encodeHeader(head)];
				for (const [index, entry] of entries.entries()) {
					const before = noise[index];
					if (before !== undefined) {
						input.push(before);
					}
					input.push(encodeEntry(entry));
				}

				const loaded = loadRecord(input);
				expect(loaded.ok).toBe(true);
				if (!loaded.ok) {
					return;
				}
				expect(loaded.value.entries).toEqual(entries);
			},
		),
		{ numRuns: 300 },
	);
});
