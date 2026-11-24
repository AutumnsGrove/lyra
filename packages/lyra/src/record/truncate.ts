/**
 * The entry cap, and truncation to stay under it (docs/run-record.md, decision 90).
 *
 * A save that fails for size would fail a run midway, so content that could exceed
 * the cap is cut before it is written, and the entry says what was cut and how much
 * (`truncated`), with a marker in the text as well so a person reading the record
 * sees it too.
 *
 * Only content is cut. Ids, types, times and the pairing of a call with its result
 * are never touched, because a record that no longer loads would be worse than one
 * that lost a paragraph. The one case that gives up is a structure too big on its
 * own — thousands of calls in one turn — and it is refused rather than half-saved,
 * so pairing cannot be quietly broken.
 */

import {
	encodeEntry,
	type AssistantMessageEntry,
	type CompactionEntry,
	type RecordEntry,
	type ToolMessageEntry,
	type Truncation,
} from "./entries.js";

const encoder = new TextEncoder();

/** UTF-8 bytes, which is what a storage limit is measured in. */
export function utf8Length(text: string): number {
	return encoder.encode(text).length;
}

function markerFor(droppedBytes: number): string {
	return `\n…[truncated: ${droppedBytes} bytes dropped]`;
}

/**
 * A marker with the widest number it could hold, used while measuring. Anything
 * measured with it is measured pessimistically, so the real marker always fits.
 */
const WIDEST_MARKER = markerFor(Number.MAX_SAFE_INTEGER);

export interface Fitted {
	entry: RecordEntry;
	line: string;
	/** Set when the structure alone is over the cap and nothing can be cut to help. */
	refused?: string;
}

type TextField = "content" | "arguments" | "reasoning" | "text" | "summary";

interface Candidate {
	field: TextField;
	read(): string;
	write(value: string): void;
	/**
	 * How to remove the field from the entry when it loses everything it held, for a
	 * field that is optional in the record. Writing `""` there would claim the model
	 * produced an empty value, and a client cannot tell that from no value at all
	 * (EVT09, found in review on pull request #76).
	 */
	drop?(): void;
}

/**
 * The kinds with content worth cutting: a summary is the fourth, because a model
 * asked to summarize can answer at any length and the entry it becomes is an
 * entry like any other (docs/context-size.md). Everything else is small by
 * construction.
 */
type Truncatable = AssistantMessageEntry | ToolMessageEntry | CompactionEntry;

/** The fields of an entry that may be cut, with the entry copied so the caller's is untouched. */
function textCandidates(entry: Truncatable): Candidate[] {
	switch (entry.type) {
		case "tool_message":
			return [
				{
					field: "content",
					read: () => entry.content,
					write: (value) => {
						entry.content = value;
					},
				},
			];
		case "compaction":
			return [
				{
					field: "summary",
					read: () => entry.summary,
					write: (value) => {
						entry.summary = value;
					},
				},
			];
		case "assistant_message": {
			const candidates: Candidate[] = entry.toolCalls.map((call) => ({
				field: "arguments" as const,
				read: () => call.arguments,
				write: (value) => {
					call.arguments = value;
				},
			}));
			candidates.push({
				field: "reasoning",
				read: () => entry.reasoning ?? "",
				write: (value) => {
					entry.reasoning = value;
				},
				drop: () => {
					delete entry.reasoning;
				},
			});
			candidates.push({
				field: "text",
				read: () => entry.text,
				write: (value) => {
					entry.text = value;
				},
			});
			return candidates;
		}
		default:
			return [];
	}
}

/** A deep-enough copy that cutting a field cannot reach the caller's entry. */
function copyForCutting(entry: Truncatable): Truncatable {
	if (entry.type === "assistant_message") {
		return { ...entry, toolCalls: entry.toolCalls.map((call) => ({ ...call })) };
	}
	return { ...entry };
}

/** The size the entry would have with a `truncated` marker naming this field. */
function sizeWith(entry: Truncatable, field: Truncation["field"], droppedBytes: number): number {
	return utf8Length(encodeEntry({ ...entry, truncated: { field, droppedBytes } }));
}

/**
 * The line measured with the widest number the marker could hold, for the search
 * below: anything measured this way is measured pessimistically, so the real marker
 * always fits.
 */
function sizeWithMarker(entry: Truncatable, field: Truncation["field"]): number {
	return sizeWith(entry, field, Number.MAX_SAFE_INTEGER);
}

function sliceAtCodePoint(text: string, length: number): string {
	// A lone high surrogate would turn into a replacement character when encoded, so
	// a cut one code unit earlier keeps the text exactly as it was, only shorter.
	const code = text.charCodeAt(length - 1);
	if (length > 0 && code >= 0xd800 && code <= 0xdbff) {
		return text.slice(0, length - 1);
	}
	return text.slice(0, length);
}

/**
 * Cut a piece of text to a byte budget, with a marker saying how much went and,
 * when the tool offers one, how to ask for the rest (decision 40).
 *
 * The marker's own size is counted, so the result is never over the budget the
 * caller asked for, and a cut that lands inside a character's bytes moves back
 * one so the text stays the text it was.
 */
export function cutText(
	text: string,
	maxBytes: number,
	hint?: string,
): { text: string; droppedBytes: number } | undefined {
	const total = utf8Length(text);
	if (total <= maxBytes) {
		return undefined;
	}
	const suffix = hint === undefined || hint === "" ? "" : ` ${hint}`;
	// Measured with the widest number the marker could carry, so the real one fits.
	const marker = (dropped: number): string => `${markerFor(dropped)}${suffix}`;
	const budget = (length: number): boolean =>
		utf8Length(sliceAtCodePoint(text, length)) <= maxBytes;
	const fits = (length: number): boolean =>
		utf8Length(sliceAtCodePoint(text, length) + marker(Number.MAX_SAFE_INTEGER)) <= maxBytes;

	// A cap smaller than the marker itself cannot carry a note. The cut is then
	// silent: a result over the cap the tool set is worse than one without a
	// marker, and the tool's own cap is the thing that has to hold.
	if (!fits(0)) {
		const kept = sliceAtCodePoint(text, largest(budget, text.length));
		return { text: kept, droppedBytes: total - utf8Length(kept) };
	}

	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	const kept = sliceAtCodePoint(text, low);
	const droppedBytes = total - utf8Length(kept);
	return { text: kept + marker(droppedBytes), droppedBytes };
}

/**
 * The longest prefix of `length` characters that `fits` accepts, by halving. It
 * returns 0 when nothing does, which is a cap of zero or a character that is
 * itself over the budget.
 */
function largest(fits: (length: number) => boolean, length: number): number {
	let low = 0;
	let high = length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (fits(middle)) {
			low = middle;
		} else {
			high = middle - 1;
		}
	}
	return low;
}

export function fitEntry(entry: RecordEntry, maxBytes: number): Fitted {
	const line = encodeEntry(entry);
	if (utf8Length(line) <= maxBytes) {
		return { entry, line };
	}
	if (
		entry.type !== "assistant_message" &&
		entry.type !== "tool_message" &&
		entry.type !== "compaction"
	) {
		// A status, a user message or an unknown kind has no content to cut, and a
		// user message this big is refused before it is ever saved.
		return { entry, line, refused: `a ${entry.type} entry has no content to cut` };
	}

	let working = copyForCutting(entry);
	let dropped = 0;

	// Details are for a person reading the record, never for the model, so they go
	// whole before any text is cut: nothing a resume replays depends on them.
	if (working.type === "tool_message" && working.details !== undefined) {
		dropped += utf8Length(JSON.stringify(working.details));
		const { details: _details, ...rest } = working;
		working = { ...rest };
		if (sizeWithMarker(working, "details") <= maxBytes) {
			const truncated: Truncatable = {
				...working,
				truncated: { field: "details", droppedBytes: dropped },
			};
			return { entry: truncated, line: encodeEntry(truncated) };
		}
	}

	// The largest field frees the most room, and it is usually the only one cut.
	const candidates = textCandidates(working).sort(
		(left, right) => utf8Length(right.read()) - utf8Length(left.read()),
	);

	for (const candidate of candidates) {
		const original = candidate.read();
		if (original === "") {
			continue;
		}
		const originalBytes = utf8Length(original);
		candidate.write("");

		// The search below assumes that keeping none of the text fits, so that is what
		// is checked -- with the marker, which is part of the saved text. Measuring the
		// structure alone left a window where the check passed and no length fitted,
		// and the search then returned the marker on an empty field: a line over the
		// cap (found by the committed corpus, issue #41).
		//
		// The marker here is the one this entry would really carry, not the widest one:
		// keeping nothing makes both counts exact, and the widest would refuse an entry
		// whose marker-only line fits -- a save that fits turned into a failed run,
		// which REC04 forbids (found in review).
		const fits = (length: number): boolean => {
			candidate.write(sliceAtCodePoint(original, length) + WIDEST_MARKER);
			const size = sizeWithMarker(working, candidate.field);
			candidate.write("");
			return size <= maxBytes;
		};

		candidate.write(markerFor(originalBytes));
		const markerOnlyFits =
			sizeWith(working, candidate.field, dropped + originalBytes) <= maxBytes;
		candidate.write("");

		if (!markerOnlyFits) {
			// Emptying this field is not enough on its own, so it goes whole and its
			// bytes join the total. Leaving them uncounted would save an entry that lost
			// a kilobyte with nothing in it saying so, and a resume would replay a call
			// with no arguments at all. A field the record does not require is removed
			// rather than emptied, because `""` reads as a value the model produced.
			dropped += originalBytes;
			if (candidate.drop === undefined) {
				candidate.write("");
			} else {
				candidate.drop();
			}
			continue;
		}
		let low = 0;
		let high = original.length;
		while (low < high) {
			const middle = Math.ceil((low + high) / 2);
			if (fits(middle)) {
				low = middle;
			} else {
				high = middle - 1;
			}
		}
		const kept = sliceAtCodePoint(original, low);
		const droppedHere = originalBytes - utf8Length(kept);
		candidate.write(kept + markerFor(droppedHere));

		const truncated: Truncatable = {
			...working,
			truncated: { field: candidate.field, droppedBytes: dropped + droppedHere },
		};
		return { entry: truncated, line: encodeEntry(truncated) };
	}

	// Nothing left to cut and it still does not fit: the structure is the problem.
	return {
		entry: working,
		line: encodeEntry(working),
		refused: "this entry's structure is over the cap on its own",
	};
}
