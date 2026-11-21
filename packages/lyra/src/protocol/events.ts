/**
 * A record entry as the protocol's events (docs/protocol.md, "Replay from the
 * record"; decision 86).
 *
 * The projection is a pure function of a whole record, so replaying a record
 * always gives the same events with the same `seq`, and a client that reconnects
 * reads the record and keeps the events after the one it last saw. The live-only
 * events (`retry`, `tool_start`, `tool_update`, `text_delta`) never appear here:
 * they are not in the record, and a reconnect must not be told about something
 * that already passed.
 *
 * Several events come from one entry and share its `seq`, so a reconnect resumes
 * "after entry n" and never sees half of an entry's events. The record is a
 * straight line today, so an entry's position in the active path is the position
 * storage appended it at.
 */

import { parkedReasonOf, type ParkedReason, type RunEndReason } from "../core/events.js";
import type { FinishReason, ToolCall, Usage } from "../core/model.js";
import { createUsageTotal } from "../core/usage.js";
import type { RecordEntry } from "../record/entries.js";
import { activePath } from "../record/replay.js";

/** What every projected event carries, whatever its type. */
interface EventBase {
	/** The record entry's zero-based position, from `StorageSlot.append`. */
	seq: number;
	/** The entry's own time, not the time it was sent. */
	ts: number;
	session: string;
	run: string;
}

export type RecordEvent =
	| (EventBase & { type: "run_start" })
	| (EventBase & { type: "resumed" })
	| (EventBase & { type: "message_end"; text: string; toolCalls: ToolCall[] })
	| (EventBase & { type: "tool_call"; call: ToolCall })
	| (EventBase & {
			type: "tool_end";
			callId: string;
			name: string;
			isError: boolean;
			content: string;
	  })
	| (EventBase & { type: "turn_end"; turn: number; finishReason: FinishReason })
	| (EventBase & {
			type: "usage";
			inputTokens: number;
			outputTokens: number;
			cost?: Usage["cost"];
	  })
	| (EventBase & { type: "fallback"; from: string; to: string; reason: string })
	| (EventBase & { type: "parked"; reason: ParkedReason; detail?: string })
	| (EventBase & {
			type: "run_end";
			reason: RunEndReason;
			turn: number;
			usage: Usage;
			parkedReason?: ParkedReason;
			detail?: string;
	  });

export interface ProjectionContext {
	session: string;
	run: string;
}

/**
 * A record as the events a client watching it would have seen. The turn count and
 * the usage total carry across a resume, because that is what a limit and a
 * resume both count against, and a `run_end` reports the run, not the segment.
 */
export function projectEvents(
	entries: readonly RecordEntry[],
	context: ProjectionContext,
): RecordEvent[] {
	const events: RecordEvent[] = [];
	const usage = createUsageTotal();
	/** The tools each call id named, so a tool's own entry can say which tool it was. */
	const callNames = new Map<string, string>();
	let turn = 0;

	for (const [seq, entry] of activePath(entries).entries()) {
		const base: EventBase = { seq, ts: entry.ts, session: context.session, run: context.run };

		switch (entry.type) {
			case "status": {
				const detail = entry.detail === undefined ? {} : { detail: entry.detail };
				if (entry.state === "running" || entry.state === "resumed") {
					// A resume begins a new segment of the same run (CMD07), so it is
					// announced as both the resume and the start of work.
					if (entry.state === "resumed") {
						events.push({ ...base, type: "resumed" });
					}
					events.push({ ...base, type: "run_start" });
				} else if (entry.state === "parked") {
					const reason = parkedReasonOf(entry.reason);
					events.push({ ...base, type: "parked", reason, ...detail });
					events.push({
						...base,
						type: "run_end",
						reason: "parked",
						parkedReason: reason,
						turn,
						usage: usage.total(),
						...detail,
					});
				} else {
					// `done` and `failed` are the only remaining states: both end the run.
					events.push({
						...base,
						type: "run_end",
						reason: entry.state,
						turn,
						usage: usage.total(),
					});
				}
				break;
			}
			case "assistant_message": {
				turn += 1;
				usage.add(entry.usage);
				for (const call of entry.toolCalls) {
					callNames.set(call.id, call.name);
				}
				events.push({
					...base,
					type: "message_end",
					text: entry.text,
					toolCalls: entry.toolCalls,
				});
				for (const call of entry.toolCalls) {
					events.push({ ...base, type: "tool_call", call });
				}
				events.push({
					...base,
					type: "turn_end",
					turn,
					finishReason: entry.finishReason,
				});
				const cost = entry.usage.cost === undefined ? {} : { cost: entry.usage.cost };
				events.push({
					...base,
					type: "usage",
					inputTokens: entry.usage.inputTokens,
					outputTokens: entry.usage.outputTokens,
					...cost,
				});
				break;
			}
			case "tool_message":
				events.push({
					...base,
					type: "tool_end",
					callId: entry.toolCallId,
					// A result whose call is not in the path is still reported; the name it
					// lost is the empty string rather than a guess.
					name: callNames.get(entry.toolCallId) ?? "",
					isError: entry.isError,
					content: entry.content,
				});
				break;
			case "fallback":
				events.push({
					...base,
					type: "fallback",
					from: entry.from,
					to: entry.to,
					reason: entry.reason,
				});
				break;
			case "user_message":
			case "recipe_updated":
			case "note":
			case "unknown":
				// A user message, a changed pin and a note for a person are in the record
				// but are not protocol events; a kind this build does not know is not ours.
				break;
		}
	}

	return events;
}

/** The events a client that last saw `seq` still needs, in the order they happened. */
export function eventsAfter(events: readonly RecordEvent[], seq: number): RecordEvent[] {
	return events.filter((event) => event.seq > seq);
}
