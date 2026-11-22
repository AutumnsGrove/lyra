/**
 * Replay: the record as the conversation the model sees (docs/run-record.md,
 * RCD02, decision 32).
 *
 * The active path is the chain from the last entry back through its parents. It
 * is a straight line today, and walking it rather than listing the entries in
 * storage order is what leaves room for a branch later (decision 30). A chain
 * that ends early, because a parent was skipped or loops, simply stops: replay
 * never invents an entry and never throws.
 */

import type { ConversationMessage } from "../core/conversation.js";
import type { RecordEntry } from "./entries.js";

/** Root first, last entry last. Unknown kinds are part of the chain but not the conversation. */
export function activePath(entries: readonly RecordEntry[]): RecordEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const path: RecordEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);

	while (current !== undefined && !seen.has(current.id)) {
		seen.add(current.id);
		path.push(current);
		current = current.parent === null ? undefined : byId.get(current.parent);
	}

	return path.reverse();
}

/**
 * One entry as the message the model sees, when it is one at all. The live loop
 * and the compaction view both call this, so a replayed conversation and a live
 * one cannot drift.
 */
export function entryMessage(entry: RecordEntry): ConversationMessage | undefined {
	switch (entry.type) {
		case "user_message":
			return { role: "user", text: entry.text };
		case "assistant_message":
			return entry.reasoning === undefined
				? { role: "assistant", text: entry.text, toolCalls: entry.toolCalls }
				: {
						role: "assistant",
						text: entry.text,
						reasoning: entry.reasoning,
						toolCalls: entry.toolCalls,
					};
		case "tool_message":
			return {
				role: "tool",
				toolCallId: entry.toolCallId,
				content: entry.content,
				isError: entry.isError,
			};
		case "status":
		case "note":
		case "fallback":
		case "recipe_updated":
		case "compaction":
		case "unknown":
			// A status is progress, a note is for a person, a compaction and a pin are
			// how the view is built rather than something in it, and an unknown kind is
			// not ours to read.
			return undefined;
	}
}

export function replayConversation(entries: RecordEntry[]): ConversationMessage[] {
	const messages: ConversationMessage[] = [];
	for (const entry of activePath(entries)) {
		const message = entryMessage(entry);
		if (message !== undefined) {
			messages.push(message);
		}
	}
	return messages;
}
