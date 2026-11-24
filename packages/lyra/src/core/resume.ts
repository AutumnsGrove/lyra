/**
 * Reading a run back out of its record (decisions 20, 23, 24).
 *
 * A resume is not a new run: it continues the conversation the record replayed,
 * with the turns and tokens already spent counted, so a limit means the same thing
 * across an interruption. Everything here is derived from the record and nothing is
 * guessed: a record with no usable header is refused rather than given an invented
 * run id, and an entry kind this build does not know is part of the chain but not
 * the conversation.
 *
 * The record cannot say whether a killed tool ran, so the last assistant turn's
 * calls that have no result after it are reported rather than assumed
 * (`unansweredCalls`), and the loop decides what may be repeated (decision 24).
 * A result can be missing even when a later call's result was saved, because a
 * batch saves each answer as it arrives, which is why this looks at the whole tail
 * and not only at the last entry.
 */

import type {
	AssistantMessageEntry,
	RecipeStamp,
	RecordEntry,
	RequestAnsweredEntry,
	RequestEntry,
	StatusEntry,
	UserMessageEntry,
} from "../record/entries.js";
import { isJsonValue, isPlainObject, type JsonValue } from "./json.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
import { activePath, replayConversation } from "../record/replay.js";
import type { Ids } from "./clock.js";
import type { ConversationMessage } from "./conversation.js";
import type { ToolCall, Usage } from "./model.js";
import { ok, type Result } from "./result.js";

export interface ResumeSeed {
	record: LoadedRecord;
	/** The conversation to continue, exactly as the model last saw it. */
	messages: ConversationMessage[];
	/** The id of the last entry, which is what the next entry's `parent` is. */
	parent: string | null;
	/** Model turns already taken. */
	turns: number;
	/** What each reply reported, oldest first, so the totals survive a resume. */
	usages: Usage[];
	/**
	 * What each summary call reported, oldest first. A summary is a call like any
	 * other for a limit, so its cost has to survive an interruption too (CMP14).
	 */
	summaryUsages: Usage[];
	/**
	 * The input tokens the provider counted for the last request, when nothing has
	 * cut the view since. Absent when a compaction came after that reply, because
	 * the number then describes a conversation the cut has already shortened.
	 */
	lastInputTokens: number | undefined;
	/** Active milliseconds already spent in closed segments of the run. */
	activeMs: number;
	/** The last status on the path. */
	status: StatusEntry | undefined;
	/** The last message-shaped entry on the path, which decides what happens next. */
	last: RecordEntry | undefined;
	/** Tool names the record already holds a call for, on the path. */
	usedTools: ReadonlySet<string>;
	/** Calls of the last assistant turn that have no result saved after it. */
	unansweredCalls: ToolCall[];
	/**
	 * The run's last act was a tool result that passed the done-check (decision 25).
	 * Only when it is the last message: a follow-up saved after it means the run has
	 * more to do, and a resume that stopped there would silently drop it.
	 */
	finished: boolean;
	/**
	 * Whether any result of the last assistant turn passed the done-check. A group may
	 * save that result behind a question in the same reply, so the loop cannot read
	 * "the record's last entry" for this any more (decision 154).
	 */
	doneInLastReply: boolean;
	/** The pin the run was last held to: the header's, or the latest `recipe_updated`'s. */
	pin: RecipeStamp | undefined;
	/**
	 * The request the run is waiting on, when it is waiting for a person. Until the
	 * answer is on the record, a resume has nothing to continue with (decision 34).
	 */
	pendingRequest: RequestEntry | undefined;
	/** What a person decided about that request, once the record holds it. */
	answer: RequestAnsweredEntry | undefined;
	/**
	 * The task's input as JSON, from the `task` message's details, so a resume can run
	 * the recipe's `setup` again. Absent on a record written before step 3, and on one
	 * whose task message never landed (decision 112).
	 */
	input: JsonValue | undefined;
}

/** The input saved on a `task` message, if it is there and shaped as this build writes it. */
function inputOf(message: UserMessageEntry | undefined): JsonValue | undefined {
	const details = message?.details;
	if (!isPlainObject(details) || !Object.prototype.hasOwnProperty.call(details, "input")) {
		return undefined;
	}
	const input = details["input"];
	return isJsonValue(input) ? input : undefined;
}

/**
 * Move the id source past every id the record already holds.
 *
 * The record is the truth about which ids are taken, and a host's `Ids` has no
 * memory of a previous process: a counter starts again at one, and a resume that
 * wrote `e1` into a record that already had one would have its line skipped as a
 * duplicate, losing a step. This advances a counter until it is clear of the record
 * and costs a random source one draw, which is why it is a loop rather than a check.
 */
export function reserveIds(ids: Ids, entries: readonly RecordEntry[]): void {
	// Every prefix the record used, not only the entry ids: a request's id and a
	// proposal's are made by the same source, so a resume that only skipped `e`
	// would hand out `auth1` and `prop1` twice and make the second undecidable.
	const usedByPrefix = new Map<string, Set<string>>();
	const note = (prefix: string, id: string): void => {
		const used = usedByPrefix.get(prefix) ?? new Set<string>();
		used.add(id);
		usedByPrefix.set(prefix, used);
	};
	for (const entry of entries) {
		note("e", entry.id);
		if (entry.type === "request") {
			note("auth", entry.request);
		}
		if (entry.type === "proposal") {
			note("prop", entry.proposal);
		}
	}
	// The entry prefix is always reserved, because the next write is an entry.
	usedByPrefix.set("e", usedByPrefix.get("e") ?? new Set<string>());
	for (const [prefix, used] of usedByPrefix) {
		// A finite source that can only answer with used ids must not hang the resume;
		// the loader skips a duplicate rather than crashing, so giving up is safe.
		for (let attempt = 0; attempt <= used.size; attempt += 1) {
			if (!used.has(ids.next(prefix))) {
				break;
			}
		}
	}
}

export function readResumeSeed(lines: readonly string[]): Result<ResumeSeed> {
	const loaded = loadRecord([...lines]);
	if (!loaded.ok) {
		return loaded;
	}
	const path = activePath(loaded.value.entries);

	let turns = 0;
	const usages: Usage[] = [];
	const summaryUsages: Usage[] = [];
	let activeMs = 0;
	let openSegment: number | undefined;
	let status: StatusEntry | undefined;
	let last: RecordEntry | undefined;
	let assistant: { entry: AssistantMessageEntry; index: number } | undefined;
	/** Where the last reply and the last compaction sat, which decides the base. */
	let lastReplyAt = -1;
	let lastCompactionAt = -1;
	let pin = loaded.value.header.recipe;
	let pendingRequest: RequestEntry | undefined;
	let answer: RequestAnsweredEntry | undefined;
	let taskMessage: UserMessageEntry | undefined;
	const usedTools = new Set<string>();

	for (const [index, entry] of path.entries()) {
		switch (entry.type) {
			case "status":
				status = entry;
				if (entry.state === "running" || entry.state === "resumed") {
					openSegment = entry.ts;
				} else if (openSegment !== undefined) {
					// A parked, done or failed segment is time the run did not spend working.
					activeMs += Math.max(0, entry.ts - openSegment);
					openSegment = undefined;
				}
				break;
			case "assistant_message":
				turns += 1;
				usages.push(entry.usage);
				for (const call of entry.toolCalls) {
					usedTools.add(call.name);
				}
				assistant = { entry, index };
				lastReplyAt = index;
				last = entry;
				break;
			case "user_message":
				if (entry.label === "task" && taskMessage === undefined) {
					taskMessage = entry;
				}
				last = entry;
				break;
			case "tool_message":
				last = entry;
				break;
			case "recipe_updated":
				pin = entry.to;
				break;
			case "request":
				pendingRequest = entry;
				answer = undefined;
				break;
			case "request_answered":
				if (pendingRequest?.request === entry.request) {
					answer = entry;
				}
				break;
			case "compaction":
				summaryUsages.push(entry.usage);
				lastCompactionAt = index;
				break;
			case "fallback":
			case "note":
			case "unknown":
				break;
		}
	}

	// A request stops being live once the call it named has a result: the answer has
	// done its work, and every later resume is about what came after it.
	if (pendingRequest !== undefined && pendingRequest.callId !== undefined) {
		const callId = pendingRequest.callId;
		const requestAt = path.findIndex((entry) => entry.id === pendingRequest?.id);
		const settled = path.some(
			(entry, index) =>
				index > requestAt && entry.type === "tool_message" && entry.toolCallId === callId,
		);
		if (settled) {
			pendingRequest = undefined;
			answer = undefined;
		}
	}

	const answeredAfter = new Set<string>();
	if (assistant !== undefined) {
		for (const [index, entry] of path.entries()) {
			if (index > assistant.index && entry.type === "tool_message") {
				answeredAfter.add(entry.toolCallId);
			}
		}
	}
	const unansweredCalls =
		assistant === undefined
			? []
			: assistant.entry.toolCalls.filter((call) => !answeredAfter.has(call.id));
	// A `done` result may sit behind a question of the same reply, because a group
	// saves what ran either side of the question. So "did this reply finish" is asked
	// of its results rather than of the record's last line, and a reply with a call
	// still waiting for a person is not finished whatever its results say.
	// The last `done` result of that reply, if a message a person wrote did not come
	// after it: a follow-up saved behind an accepted finish means the run has more to
	// do, which is what RSM01 is about.
	let doneAt = -1;
	if (assistant !== undefined) {
		for (let index = path.length - 1; index > assistant.index; index -= 1) {
			const entry = path[index];
			if (entry?.type === "tool_message" && entry.done === true) {
				doneAt = index;
				break;
			}
		}
		if (doneAt !== -1) {
			for (let index = doneAt + 1; index < path.length; index += 1) {
				if (path[index]?.type === "user_message") {
					doneAt = -1;
					break;
				}
			}
		}
	}
	const doneInLastReply = doneAt !== -1;

	return ok({
		record: loaded.value,
		messages: replayConversation(loaded.value.entries),
		parent: loaded.value.entries.at(-1)?.id ?? null,
		turns,
		usages,
		summaryUsages,
		lastInputTokens:
			assistant !== undefined && lastReplyAt > lastCompactionAt
				? assistant.entry.usage.inputTokens
				: undefined,
		activeMs,
		status,
		last,
		usedTools,
		unansweredCalls,
		finished: doneInLastReply && unansweredCalls.length === 0,
		doneInLastReply,
		pin,
		pendingRequest,
		answer,
		input: inputOf(taskMessage),
	});
}
