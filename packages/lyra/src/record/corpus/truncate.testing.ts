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

/** What a case expects `fitEntry` to answer, when it expects a particular one. */
export type Outcome = "fit" | "refused";

/**
 * `[the entry to fit, the cap in bytes, what it should answer]`. The outcome is
 * optional because most cases only care that the result is honest; the boundary
 * cases name it, so the corpus guards both directions on its own rather than
 * relying on the unit test for one of them (found in review).
 */
export type TruncateCase = readonly [RecordEntry, number, Outcome?];

export const cases: Readonly<Record<string, TruncateCase>> = {
	"an-entry-that-fits-as-it-is": [entries["a-standalone-tool-message"], 20_000],
	"a-content-that-has-to-be-cut": [entries["a-tool-message-with-a-huge-content"], 500],
	"a-reasoning-that-has-to-be-cut": [entries["an-assistant-message-with-a-long-reasoning"], 400],
	"a-huge-content-at-the-smallest-cap": [
		entries["a-tool-message-with-a-huge-content"],
		164,
		"refused",
	],
	// The other side of that boundary: at 165 the structure with the field gone and a
	// marker naming it fits, so the entry has to be saved rather than refused. Before
	// #77 the loop refused every cap from 165 to 200, because it dropped the field and
	// never re-checked what the drop had left.
	"a-huge-content-once-its-field-is-dropped": [
		entries["a-tool-message-with-a-huge-content"],
		165,
		"fit",
	],
	// And the cut path has its own boundary, where the marker fits inside the content
	// instead of the field going whole: at 201 the marker-only line is exactly the cap.
	"the-marker-only-line-at-its-exact-cap": [
		entries["a-tool-message-with-a-huge-content"],
		201,
		"fit",
	],
	"a-long-reasoning-at-the-smallest-cap": [
		entries["an-assistant-message-with-a-long-reasoning"],
		200,
	],
};

/**
 * The property, shared by the generator and the replay: either the entry fits and
 * the record reads back to the same thing, or it is refused for its structure.
 */
export function holds([entry, cap, outcome]: TruncateCase): void {
	const fitted = fitEntry(entry, cap);
	if (outcome !== undefined) {
		expect(fitted.refused === undefined ? "fit" : "refused", `an entry of ${cap} bytes`).toBe(
			outcome,
		);
	}
	if (fitted.refused !== undefined) {
		// Only a structure too big on its own may be refused, and it says so.
		expect(fitted.refused).toMatch(/structure|content to cut/);
		// The line a refusal carries is the structure with the field emptied, which may
		// well be under the cap: what could not fit was that plus a marker. What has to
		// hold is that a host can still write it and read it back, so a refusal is
		// never a line nobody can load.
		const refusedLine = loadRecord([encodeHeader(header), fitted.line]);
		expect(refusedLine.ok).toBe(true);
		return;
	}
	// The cap check guards the fit path only, and it is where the over-cap bug showed
	// up: before the fix this returned a 201-byte line as a fit, for a cap of 200.
	expect(utf8Length(fitted.line)).toBeLessThanOrEqual(cap);

	// What was saved is a record that reads back to the same thing.
	const loaded = loadRecord([encodeHeader(header), fitted.line]);
	expect(loaded.ok).toBe(true);
	if (loaded.ok) {
		expect(loaded.value.notes).toEqual([]);
		expect(loaded.value.entries).toEqual([fitted.entry]);
	}
}
