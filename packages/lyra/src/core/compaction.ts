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

import type { Clock } from "./clock.js";
import type { ConversationMessage } from "./conversation.js";
import type { ModelError, ModelReply, ModelRequest, ModelSlot, Usage } from "./model.js";
import { RETRY_DELAYS_MS } from "./retry.js";
import { err, fail, ok, type Result } from "./result.js";
import type { CompactionEntry, RecordEntry } from "../record/entries.js";
import { entryMessage } from "../record/replay.js";

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

/** How a compaction summary is introduced to the model. */
const SUMMARY_LABEL = "Summary of the run so far. Older steps were compacted away:";

/**
 * What the model sees of a record: the latest summary, what each tool says its
 * state is, and the entries from the compaction's pointer on (decision 39).
 */
export interface ModelView {
	/** The entries kept verbatim, oldest first: where a later cut is chosen from. */
	entries: RecordEntry[];
	/** The latest summary, when the record has a compaction in it. */
	summary: string | undefined;
	/** What each tool rendered as its current state, in the order given. */
	stateTexts: readonly string[];
	/** The conversation to send, in order. The system text is the caller's. */
	messages: ConversationMessage[];
}

/**
 * Build the view of a record. Everything before the latest `compaction`'s pointer
 * is left out of the conversation but stays in the record, so replay still
 * rebuilds tool state from every saved result (CMP07).
 *
 * A pointer that names no entry in the path is treated as the end of the
 * compaction entry itself rather than as an error: a record whose chain is
 * damaged is already noted by the loader, and showing the model too much is
 * safer than showing it nothing.
 */
export function buildView(
	path: readonly RecordEntry[],
	stateTexts: readonly string[] = [],
): ModelView {
	let last: { entry: CompactionEntry; index: number } | undefined;
	for (const [index, entry] of path.entries()) {
		if (entry.type === "compaction") {
			last = { entry, index };
		}
	}

	let start = 0;
	if (last !== undefined) {
		const pointer = path.findIndex((entry) => entry.id === last.entry.firstKept);
		start = pointer >= 0 ? pointer : last.index + 1;
	}

	// A compaction is how the view is built rather than something in it, so a later
	// cut is chosen from the conversation entries only.
	const entries = path.slice(start).filter((entry) => entry.type !== "compaction");
	const messages: ConversationMessage[] = [];
	if (last !== undefined) {
		messages.push({ role: "user", text: `${SUMMARY_LABEL}\n${last.entry.summary}` });
	}
	for (const text of stateTexts) {
		messages.push({ role: "user", text });
	}
	for (const entry of entries) {
		const message = entryMessage(entry);
		if (message !== undefined) {
			messages.push(message);
		}
	}

	return {
		entries,
		summary: last?.entry.summary,
		stateTexts,
		messages,
	};
}

/** The most one old entry may take in a summary request, in estimated tokens. */
export const SUMMARY_ENTRY_TOKENS = 8_000;

function cappedForSummary(text: string): string {
	const limit = SUMMARY_ENTRY_TOKENS * CHARACTERS_PER_TOKEN;
	if (text.length <= limit) {
		return text;
	}
	return `${text.slice(0, limit)}\n…[cut for the summary: ${text.length - limit} characters dropped]`;
}

/** One entry as a line of the material a summary is written from. */
function describeForSummary(entry: RecordEntry): string | undefined {
	switch (entry.type) {
		case "user_message":
			return `User: ${entry.text}`;
		case "assistant_message": {
			const calls = entry.toolCalls.map((call) => `${call.name}(${call.arguments})`);
			const said = entry.text === "" ? "" : ` ${entry.text}`;
			const asked = calls.length === 0 ? "" : ` → ${calls.join(", ")}`;
			return `Assistant:${said}${asked}`;
		}
		case "tool_message":
			return `Tool result: ${cappedForSummary(entry.content)}`;
		default:
			return undefined;
	}
}

/**
 * What a summary call is given: the previous summary, which it updates rather
 * than restarts, and the steps since it, oldest first (decision 40).
 *
 * An old tool result is cut to a per-entry cap so the summary call itself fits in
 * the window it is trying to save. That loses detail, and the record keeps it:
 * `notes.md` says why the tradeoff was taken.
 */
export function summaryMaterial(view: ModelView, cut: Cut): string {
	const parts: string[] = [];
	if (view.summary !== undefined) {
		parts.push(
			`The previous summary, which you are updating rather than replacing:\n${view.summary}`,
		);
	}
	const steps: string[] = [];
	for (const entry of view.entries.slice(0, cut.index)) {
		const line = describeForSummary(entry);
		if (line !== undefined) {
			steps.push(line);
		}
	}
	parts.push(`The steps since then, oldest first:\n${steps.join("\n")}`);
	return parts.join("\n\n");
}

/**
 * How a recipe shapes compaction. Every field is optional: the defaults are
 * Nova's numbers, chosen at step 7 and recorded in `decisions.md`.
 */
export interface CompactionSettings {
	/** The model's context window, when the recipe knows it and the slot does not. */
	contextWindow?: number;
	/** How close to the window a run may come before it compacts. */
	reserveTokens?: number;
	/** How much of the most recent history to keep verbatim, in estimated tokens. */
	keepTokens?: number;
	/** The model that writes the summary, when it is not the run's own. */
	model?: string;
	/** The recipe's own summarizer instructions, replacing the default. */
	instructions?: string;
}

/** `max(16384, 10% of the window)`, which is Nova's reserve (decision 41). */
export function defaultReserveTokens(window: number): number {
	return Math.max(16_384, Math.floor(window / 10));
}

/** What the run keeps if a recipe says nothing: Nova's 20000 tokens (decision 41). */
export const DEFAULT_KEEP_TOKENS = 20_000;

/** A recipe's compaction settings, checked once so a bad one fails fast (LIM03's rule). */
export function validateCompactionSettings(
	settings: CompactionSettings,
): Result<CompactionSettings> {
	const checked: CompactionSettings = {};
	const positive = (value: number | undefined, field: string): Result<number | undefined> => {
		if (value === undefined) {
			return ok(undefined);
		}
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
			return fail("bad_request", `compaction's ${field} must be a whole number of tokens`);
		}
		return ok(value);
	};
	const window = positive(settings.contextWindow, "contextWindow");
	if (!window.ok) {
		return window;
	}
	if (window.value === 0) {
		return fail("bad_request", "compaction's contextWindow must be more than zero");
	}
	const reserve = positive(settings.reserveTokens, "reserveTokens");
	if (!reserve.ok) {
		return reserve;
	}
	const keep = positive(settings.keepTokens, "keepTokens");
	if (!keep.ok) {
		return keep;
	}
	if (window.value !== undefined) {
		checked.contextWindow = window.value;
	}
	if (reserve.value !== undefined) {
		checked.reserveTokens = reserve.value;
	}
	if (keep.value !== undefined) {
		checked.keepTokens = keep.value;
	}
	if (settings.model !== undefined) {
		if (typeof settings.model !== "string" || settings.model === "") {
			return fail("bad_request", "compaction's model must be a non-empty name");
		}
		checked.model = settings.model;
	}
	if (settings.instructions !== undefined) {
		if (typeof settings.instructions !== "string" || settings.instructions.trim() === "") {
			return fail("bad_request", "compaction's instructions must be text");
		}
		checked.instructions = settings.instructions;
	}
	return ok(checked);
}

/**
 * The instructions the summarizer is given when a recipe does not replace them.
 *
 * Shaped for a Lyra run rather than a coding chat: the goal is pinned in the system
 * text and never summarized, the tools can hand back their own exact state, and
 * what is left is progress, decisions and what is open (decision 40).
 */
export const DEFAULT_SUMMARY_INSTRUCTIONS = [
	"You are compacting the history of a run so it can go on with less context.",
	"Write a summary of the work so far, under these headings:",
	"- Goal: what the run is trying to do, in one sentence.",
	"- Progress: what has been done, in order, including any result that changed something.",
	"- Decisions: what was decided and why, where the record shows it.",
	"- Open items: what is still to do, and anything that failed and needs another try.",
	"- Exact identifiers: every handle, id, path, URL and name you copy must be copied exactly, never paraphrased.",
	"If a previous summary is given, update it: keep what is still true, correct what moved, and do not start again.",
	"Answer with the summary alone, with no preamble and no commentary.",
].join("\n");

/** What the model is asked for when the run compacts itself. */
export interface Summarizer {
	model: ModelSlot;
	/** The model to ask, when the recipe names one. */
	modelName?: string;
	instructions: string;
}

export interface Summary {
	summary: string;
	/** The model that answered, which the entry records. */
	model: string;
	usage: Usage;
}

/**
 * Ask the model for a summary, retrying a retryable failure the way the loop's own
 * requests are retried (decision 26).
 *
 * An answer that is empty or only whitespace is a failure rather than a summary: a
 * run that continued on it would have thrown away the history it meant to keep,
 * and there is no smaller answer to fall back on.
 */
export async function summarize(options: {
	summarizer: Summarizer;
	material: string;
	clock: Clock;
	signal: AbortSignal;
	/** Told about each wait, so a host can show it the way it shows a turn's retry. */
	onRetry?: (attempt: number, delayMs: number, error: ModelError) => void;
}): Promise<Result<Summary, ModelError>> {
	const request: ModelRequest = {
		system: options.summarizer.instructions,
		messages: [{ role: "user", text: options.material }],
		tools: [],
		purpose: "compaction",
		signal: options.signal,
	};
	if (options.summarizer.modelName !== undefined) {
		request.model = options.summarizer.modelName;
	}

	let retries = 0;
	for (;;) {
		let answered: Result<ModelReply, ModelError>;
		try {
			answered = await options.summarizer.model.complete(request);
		} catch (error) {
			const text = error instanceof Error ? error.message : String(error);
			return err({
				code: "internal",
				message: `the summarizer threw: ${text.slice(0, 300)}`,
				retryable: false,
			});
		}
		if (answered.ok) {
			if (answered.value.text.trim() === "") {
				return err({
					code: "provider_error",
					message: "the summarizer answered with nothing",
					retryable: false,
				});
			}
			return ok({
				summary: answered.value.text,
				model: answered.value.model,
				usage: answered.value.usage,
			});
		}
		const delay = RETRY_DELAYS_MS[retries];
		if (!answered.error.retryable || delay === undefined) {
			return answered;
		}
		const waitMs = Math.max(delay, answered.error.retryAfterMs ?? 0);
		options.onRetry?.(retries + 1, waitMs, answered.error);
		retries += 1;
		try {
			await options.clock.sleep(waitMs, options.signal);
		} catch {
			// Stopped while waiting: the caller checks the signal before believing
			// this error, so the run parks `stopped` rather than failing.
			return answered;
		}
	}
}

/** Whether the conversation is close enough to the window to compact (decision 41). */
export function shouldCompact(estimate: number, window: number, reserveTokens: number): boolean {
	return estimate > window - reserveTokens;
}

/** The tokens a conversation is guessed to cost. */
export function estimateConversation(messages: readonly ConversationMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			tokens += estimateTokens(message.text);
			if (message.reasoning !== undefined) {
				tokens += estimateTokens(message.reasoning);
			}
			for (const call of message.toolCalls) {
				tokens += estimateTokens(call.name) + estimateTokens(call.arguments);
			}
		} else if (message.role === "user") {
			tokens += estimateTokens(message.text);
		} else {
			tokens += estimateTokens(message.content);
		}
	}
	return tokens;
}

/**
 * What was added since the last request: the reply it produced, and every message
 * after it. A provider's reported input tokens only cover that request, so this is
 * the part it could not know about (decision 41).
 */
export function estimateSinceLastReply(messages: readonly ConversationMessage[]): number {
	let last = -1;
	for (const [index, message] of messages.entries()) {
		if (message.role === "assistant") {
			last = index;
		}
	}
	return last < 0 ? estimateConversation(messages) : estimateConversation(messages.slice(last));
}
