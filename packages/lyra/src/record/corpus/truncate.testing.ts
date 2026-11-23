import { expect } from "vitest";

import { encodeHeader, type RecordEntry } from "../entries.js";
import { loadRecord } from "../load.js";
import { fitEntry, utf8Length } from "../truncate.js";
import { entries, header } from "./entries.testing.js";

/**
 * The committed cases for REC04, and the property they hold: no size of content can
 * make a save fail. Each case is an entry that has to survive a cap — one that fits
 * as it is, one whose content is cut, one whose reasoning is cut, and the same
 * entries at the smallest cap the generator draws.
 *
 * The property lives here so the generator in `truncate.fuzz.test.ts` and the
 * replay in `corpus/truncate.test.ts` share one definition (issue #41).
 */

/** `[the entry to fit, the cap in bytes]`. */
export type TruncateCase = readonly [RecordEntry, number];

export const cases: Readonly<Record<string, TruncateCase>> = {
	"an-entry-that-fits-as-it-is": [entries["a-standalone-tool-message"], 20_000],
	"a-content-that-has-to-be-cut": [entries["a-tool-message-with-a-huge-content"], 500],
	"a-reasoning-that-has-to-be-cut": [entries["an-assistant-message-with-a-long-reasoning"], 400],
	"a-huge-content-at-the-smallest-cap": [entries["a-tool-message-with-a-huge-content"], 200],
	"a-long-reasoning-at-the-smallest-cap": [
		entries["an-assistant-message-with-a-long-reasoning"],
		200,
	],
};

/**
 * The property, shared by the generator and the replay: either the entry fits and
 * the record reads back to the same thing, or it is refused for its structure.
 */
export function holds([entry, cap]: TruncateCase): void {
	const fitted = fitEntry(entry, cap);
	if (fitted.refused !== undefined) {
		// Only a structure too big on its own may be refused, and it says so.
		expect(fitted.refused).toMatch(/structure|content to cut/);
		// The line a refusal carries is the structure with the field emptied, which may
		// well be under the cap: what could not fit was that plus a marker. So the
		// invariant below is "a line over the cap is never returned as a fit", which is
		// the shape of the bug this corpus found, and the case that found it was this
		// file's cap-200 entry (it returned 201 before the fix, caught by the assertion
		// under this early return).
		return;
	}
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(cap);

	// What was saved is a record that reads back to the same thing.
	const loaded = loadRecord([encodeHeader(header), fitted.line]);
	expect(loaded.ok).toBe(true);
	if (loaded.ok) {
		expect(loaded.value.notes).toEqual([]);
		expect(loaded.value.entries).toEqual([fitted.entry]);
	}
}
