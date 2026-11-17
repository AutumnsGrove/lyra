/**
 * Loading a record, tolerantly (docs/run-record.md, RCD01 to RCD07).
 *
 * A record is read by a run that may have been written by older code, cut off by
 * an eviction, or damaged where a host died mid-write. So a line that cannot be
 * used is skipped and noted, never fatal (decision 31), and a kind this build
 * does not know is kept as it was. What is fatal is having no usable header: a
 * record without one has no run id, and inventing one would let a resume pretend
 * to be a run it is not.
 *
 * Notes name the line and the problem, never the line's content: a damaged record
 * is untrusted data, and its text does not belong in a log or an error message.
 */

import { isPlainObject } from "../core/json.js";
import { fail, ok, type Result } from "../core/result.js";
import { decodeEntry, decodeHeader, type RecordEntry, type RecordHeader } from "./entries.js";

export interface LoadNote {
	/** The line's position in the saved record, counting the header as line 1. */
	line: number;
	problem: string;
}

export interface LoadedRecord {
	header: RecordHeader;
	/** In the order they were saved. */
	entries: RecordEntry[];
	/** What was skipped or looked wrong, in line order. */
	notes: LoadNote[];
}

/** An entry with the line it was saved on, which is what a note points at. */
interface Located {
	entry: RecordEntry;
	line: number;
}

export function loadRecord(lines: string[]): Result<LoadedRecord> {
	const first = lines[0];
	if (first === undefined) {
		return fail("bad_request", "the record is empty");
	}

	let parsedFirst: unknown;
	try {
		parsedFirst = JSON.parse(first);
	} catch {
		return fail("bad_request", "the first line of a record is not valid JSON");
	}
	const header = decodeHeader(parsedFirst);
	if (!header.ok) {
		return header;
	}

	const notes: LoadNote[] = [];
	const located: Located[] = [];
	/** The line each id was first seen on, which is how a duplicate is reported. */
	const firstSeen = new Map<string, number>();

	for (const [index, line] of lines.entries()) {
		if (index === 0) {
			continue;
		}
		const lineNumber = index + 1;

		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			notes.push({ line: lineNumber, problem: "not valid JSON" });
			continue;
		}
		if (!isPlainObject(parsed)) {
			notes.push({ line: lineNumber, problem: "not a JSON object" });
			continue;
		}
		if (parsed["type"] === "header") {
			notes.push({ line: lineNumber, problem: "a second header" });
			continue;
		}

		const decoded = decodeEntry(parsed, line);
		if (!decoded.ok) {
			notes.push({ line: lineNumber, problem: decoded.error.message });
			continue;
		}
		const entry = decoded.value;
		const seen = firstSeen.get(entry.id);
		if (seen !== undefined) {
			notes.push({ line: lineNumber, problem: `duplicate id, first seen on line ${seen}` });
			continue;
		}
		firstSeen.set(entry.id, lineNumber);
		located.push({ entry, line: lineNumber });
	}

	noteBrokenChains(located, notes);
	return ok({
		header: header.value,
		entries: located.map((item) => item.entry),
		notes,
	});
}

/**
 * A parent that is not there, or a chain that loops back on itself. Both mean the
 * same thing to a reader: part of the history is unreachable from the last entry,
 * so replay stops where the chain stops instead of inventing a path.
 */
function noteBrokenChains(located: Located[], notes: LoadNote[]): void {
	const byId = new Map(located.map((item) => [item.entry.id, item]));
	const settled = new Set<string>();

	for (const { entry, line } of located) {
		if (entry.parent !== null && !byId.has(entry.parent)) {
			notes.push({ line, problem: "its parent is not in the record" });
		}

		const trail: string[] = [];
		let current: string | null = entry.id;
		while (current !== null && !settled.has(current)) {
			if (trail.includes(current)) {
				notes.push({ line, problem: "its parent chain loops" });
				break;
			}
			trail.push(current);
			current = byId.get(current)?.entry.parent ?? null;
		}
		for (const id of trail) {
			settled.add(id);
		}
	}
}
