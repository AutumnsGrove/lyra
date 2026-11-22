/**
 * The cut, and what a history is guessed to cost (docs/context-size.md, decisions
 * 39 to 41).
 *
 * Compaction never deletes from the record. It writes a `compaction` entry naming
 * the first entry the model still sees, and the view is built from that pointer,
 * so replay and the record keep everything (decision 39). This module is the pure
 * half of that: how many tokens a piece of text is guessed to cost, and where the
 * cut may fall.
 *
 * The estimate is four characters to a token. It is a smoke alarm rather than
 * billing: the trigger adds it to the input tokens the provider reported for the
 * last request, so it only has to be roughly right about what arrived since.
 *
 * A cut is only allowed to start a step, never to land on a tool result: a result
 * whose call was summarized away would leave the model with an answer to a
 * question it cannot see, and a provider refuses that (CMP02).
 */

import type { RecordEntry } from "../record/entries.js";

/** Four characters to a token, the estimate decision 41 settled on. */
const CHARACTERS_PER_TOKEN = 4;

/** How many tokens a piece of text is guessed to cost, rounded up. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARACTERS_PER_TOKEN);
}

/**
 * What one entry costs the model. A status, a note, a pin and a compaction are in
 * the record but never in the conversation, so they are free here too.
 */
export function entryTokens(entry: RecordEntry): number {
	switch (entry.type) {
		case "user_message":
			return estimateTokens(entry.text);
		case "assistant_message": {
			let tokens = estimateTokens(entry.text);
			if (entry.reasoning !== undefined) {
				tokens += estimateTokens(entry.reasoning);
			}
			for (const call of entry.toolCalls) {
				tokens += estimateTokens(call.name) + estimateTokens(call.arguments);
			}
			return tokens;
		}
		case "tool_message":
			return estimateTokens(entry.content);
		default:
			return 0;
	}
}

/** The entries that carry a message, which are the only ones a cut may start on. */
function startsStep(entry: RecordEntry): boolean {
	return entry.type === "user_message" || entry.type === "assistant_message";
}

/** Where a compaction cuts: the first entry kept, its position, and how many it replaces. */
export interface Cut {
	/** The id of the first entry the model still sees, which the entry stores. */
	firstKept: string;
	/** That entry's position in the list the cut was chosen from. */
	index: number;
	/** How many entries before the cut the summary stands in for. */
	replaces: number;
}

/**
 * Where to cut a history so the model keeps at most `keepTokens` of it.
 *
 * Nothing is cut when the whole history already fits, which is the common case
 * and also what an empty history and one that is a single step return: cutting
 * a history down to itself would only spend a summary call.
 */
export function chooseCut(entries: readonly RecordEntry[], keepTokens: number): Cut | undefined {
	if (entries.length === 0) {
		return undefined;
	}

	// What the suffix starting at each entry would cost, walked once from the end.
	const suffixTokens = new Array<number>(entries.length);
	let running = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		running += entryTokens(entries[index] as RecordEntry);
		suffixTokens[index] = running;
	}
	if ((suffixTokens[0] as number) <= keepTokens) {
		return undefined;
	}

	const last = entries.length - 1;
	let index = -1;
	// The smallest suffix that fits the budget and starts a step: the most recent
	// work the budget allows, with nothing cut in the middle of it.
	for (let candidate = 1; candidate <= last; candidate += 1) {
		const entry = entries[candidate] as RecordEntry;
		if (startsStep(entry) && (suffixTokens[candidate] as number) <= keepTokens) {
			index = candidate;
			break;
		}
	}
	if (index < 0) {
		// Not even the last step fits. Keeping it anyway is the smallest suffix that
		// is still a whole step, which is better than an empty view.
		for (let candidate = 1; candidate <= last; candidate += 1) {
			if (startsStep(entries[candidate] as RecordEntry)) {
				index = candidate;
			}
		}
	}
	if (index < 0) {
		return undefined;
	}

	return {
		firstKept: (entries[index] as RecordEntry).id,
		index,
		replaces: index,
	};
}
