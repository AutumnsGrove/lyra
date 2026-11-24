/**
 * What a run says while it happens (docs/core-loop.md, "Events").
 *
 * The names are the protocol's, so step 6 maps one to one onto a frame and does
 * not need a second vocabulary. Every event carries the run and the time from the
 * injected clock, and an event that comes from a record entry carries that
 * entry's `seq`, so a client that reconnects catches up by reading the record
 * (decision 86).
 *
 * Nothing is emitted after `run_end`, and a listener that throws is isolated: it
 * cannot reach the loop (LOOP11).
 */

import type { FinishReason, ToolCall, Usage } from "./model.js";
import type { LyraError } from "./result.js";

export type RunEndReason = "done" | "parked" | "failed";

/** Why a run parked (decision 84). */
export type ParkedReason =
	"stopped" | "stuck" | "limit" | "model_unavailable" | "waiting_for_person";

interface EventBase {
	/** The run this event belongs to. Constant for every event of a run. */
	run: string;
	/** The clock's time when the event was made, not the time it was sent. */
	ts: number;
}

export type RunEvent =
	| (EventBase & { type: "run_start"; task: string })
	| (EventBase & { type: "turn_start"; turn: number })
	/**
	 * The assistant message, saved. `seq` is that entry's position in the record.
	 * `reasoning` is the model's thinking trace as the entry holds it, and it is
	 * absent rather than empty when there was none, so a client hides the panel
	 * instead of drawing an empty one (EVT09).
	 */
	| (EventBase & {
			type: "message_end";
			seq: number;
			text: string;
			toolCalls: ToolCall[];
			reasoning?: string;
	  })
	/**
	 * A call the model asked for, announced before anything runs. It carries no
	 * `seq` because no record entry is a call: the assistant message it came from
	 * is already announced by `message_end`, and the call is named by its id.
	 */
	| (EventBase & { type: "tool_call"; call: ToolCall })
	| (EventBase & { type: "tool_start"; callId: string; name: string })
	/** The tool's result, saved. */
	| (EventBase & {
			type: "tool_end";
			seq: number;
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
	| (EventBase & { type: "error"; error: LyraError })
	/**
	 * A retryable model failure, and how long the run will wait before trying that
	 * turn again (decision 26).
	 */
	| (EventBase & { type: "retry"; attempt: number; delayMs: number; error: LyraError })
	/** The run moved to another model after the first failed its retries (decision 58). */
	| (EventBase & { type: "fallback"; from: string; to: string; reason: string })
	/**
	 * The run is waiting for a person, and the request is on the record (decision 34).
	 * A host with a Waking slot arranges the timeout from here, and a client that is
	 * watching learns what is being asked.
	 */
	| (EventBase & {
			type: "request";
			seq: number;
			request: string;
			callId?: string;
			timeoutMs?: number;
	  })
	/**
	 * The run summarized its older steps and moved the model's view forward
	 * (docs/context-size.md, decision 39). `seq` is the `compaction` entry's
	 * position in the record, so a reconnecting client sees it too.
	 */
	| (EventBase & {
			type: "compaction";
			seq: number;
			summary: string;
			replaces: number;
			trigger: "auto" | "manual";
	  })
	| (EventBase & {
			type: "run_end";
			reason: RunEndReason;
			parkedReason?: ParkedReason;
			/** Which part of the reason, when it has one: a limit's `steps`, `tokens`, `time` or `cost`. */
			detail?: string;
	  });

/** A listener is never allowed to be the reason a run fails. */
export type RunEventListener = (event: RunEvent) => void;

/** The parked reasons this build knows. */
const KNOWN_PARKED_REASONS: readonly ParkedReason[] = [
	"stopped",
	"stuck",
	"limit",
	"model_unavailable",
	"waiting_for_person",
];

/**
 * A parked reason as this build knows it. A record written by a newer Lyra may name
 * one that is not here, and guessing would overrule a person's decision, so an
 * unknown reason is reported as `stuck`, which always asks a person.
 */
export function parkedReasonOf(reason: string | undefined): ParkedReason {
	return KNOWN_PARKED_REASONS.find((known) => known === reason) ?? "stuck";
}
