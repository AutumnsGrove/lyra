import { expect } from "vitest";

import { isPlainObject } from "../../core/json.js";
import { encodeEntry, encodeHeader, type RecordEntry } from "../entries.js";
import { loadRecord } from "../load.js";
import { entries, header } from "./entries.testing.js";

/**
 * The committed cases for RCD07, and the property they hold. The loader is the one
 * place a file written by anything at all is read: an eviction cut it in half, an
 * older writer left a kind this build does not know, a host wrote nonsense. Each
 * case is one of those files.
 *
 * The property lives here so the generator in `load.fuzz.test.ts` and the replay in
 * `corpus/load.test.ts` share one definition (issue #41).
 */

export interface LoadCase {
	readonly entries: readonly RecordEntry[];
	/** Lines that are not entries, interleaved before the entry at the same index. */
	readonly junk: readonly string[];
}

export const cases: Readonly<Record<string, LoadCase>> = {
	"a-record-cut-mid-line": {
		entries: [entries["a-user-message"], entries["an-assistant-message-with-two-calls"]],
		junk: ['{"type":"assistant_message","id":"e2"'],
	},
	"a-line-that-is-not-json-at-all": {
		entries: [entries["a-user-message"]],
		junk: ["not json", ""],
	},
	"a-line-that-is-a-json-array": {
		entries: [entries["a-user-message"]],
		junk: ["[1,2,3]", "null"],
	},
	"a-record-cut-off-at-the-end": {
		entries: [entries["a-user-message"], entries["an-assistant-message-with-two-calls"]],
		junk: ["", '{"type":"tool_message","id":"e3"'],
	},
	"a-header-with-nothing-after-it": { entries: [], junk: [] },
	// A parent chain and nothing else: a status whose parent is missing is a note, not
	// a clean load, which the first version of this case was.
	"a-whole-run-in-order": {
		entries: [
			entries["a-user-message"],
			entries["an-assistant-message-with-two-calls"],
			entries["a-tool-message"],
			entries["a-tool-message-that-failed"],
		],
		junk: [],
	},
};

/**
 * The property, shared by the generator and the replay: a load always returns, and
 * it never loses a line it could read.
 */
export function holds(theCase: LoadCase): void {
	// Lines that could be an entry of their own are left out, so the only entries in
	// the record are the ones the case put there.
	const noise = theCase.junk.filter((line) => {
		try {
			const parsed: unknown = JSON.parse(line);
			return !isPlainObject(parsed) || typeof parsed["type"] !== "string";
		} catch {
			return true;
		}
	});

	const input = [encodeHeader(header)];
	for (const [index, entry] of theCase.entries.entries()) {
		const before = noise[index];
		if (before !== undefined) {
			input.push(before);
		}
		input.push(encodeEntry(entry));
	}
	// Junk past the last entry trails it. An eviction cuts a record off at the end,
	// which is the shape a case named for a half-written line is really about, and
	// dropping the tail meant those cases fed the loader less than their names said
	// (found in review).
	for (const line of noise.slice(theCase.entries.length)) {
		input.push(line);
	}

	const loaded = loadRecord(input);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		return;
	}
	expect(loaded.value.entries).toEqual(theCase.entries);
	// Every junk line is reported. Without this the junk would be decoration: deleting
	// the loop that feeds it changed nothing, because the entries came out the same
	// either way (found in review). A case's junk is now load-bearing.
	expect(loaded.value.notes).toHaveLength(noise.length);
}
