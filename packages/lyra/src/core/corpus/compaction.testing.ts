import { expect } from "vitest";

import type { RecordEntry } from "../../record/entries.js";
import { entries, record } from "../../record/corpus/entries.testing.js";
import { chooseCut } from "../compaction.js";

/**
 * The committed cases for CMP02 and CMP05, and the property they hold: a record's
 * content is whatever a model and a tool wrote, and the cut has to work on it. Each
 * case is a shape the cut meets — a record that fits, one that has to be cut, a
 * single step, and a record that opens with a tool result rather than a message.
 *
 * The property lives here so the generator in `compaction.fuzz.test.ts` and the
 * replay in `corpus/compaction.test.ts` share one definition (issue #41).
 */

/** `[the record's entries, the tokens to keep]`. */
export type CompactionCase = readonly [readonly RecordEntry[], number];

export const cases: Readonly<Record<string, CompactionCase>> = {
	"a-record-that-fits": [record, 5_000],
	"a-record-that-has-to-be-cut": [record, 10],
	"a-single-step": [[entries["a-user-message"]], 0],
	"a-record-that-opens-with-a-tool-result": [
		[entries["a-tool-message"], entries["an-assistant-message-with-two-calls"]],
		0,
	],
};

/**
 * The property, shared by the generator and the replay: the cut never throws, and
 * when it cuts it starts a whole step — a `user_message` or an `assistant_message` —
 * and says which entry is the first one kept.
 */
export function holds([entriesInRecord, keepTokens]: CompactionCase): void {
	const cut = chooseCut(entriesInRecord, keepTokens);
	if (cut === undefined) {
		return;
	}
	expect(entriesInRecord[cut.index]?.id).toBe(cut.firstKept);
	expect(["user_message", "assistant_message"]).toContain(entriesInRecord[cut.index]?.type);
	expect(cut.replaces).toBe(cut.index);
}
