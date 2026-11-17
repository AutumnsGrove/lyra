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

/** Why a run parked. Step 1 knows two; step 2 adds the rest (decision 84). */
export type ParkedReason = "stopped" | "stuck";

interface EventBase {
	/** The run this event belongs to. Constant for every event of a run. */
	run: string;
	/** The clock's time when the event was made, not the time it was sent. */
	ts: number;
}

export type RunEvent =
	| (EventBase & { type: "run_start"; task: string })
	| (EventBase & { type: "turn_start"; turn: number })
	/** The assistant message, saved. `seq` is that entry's position in the record. */
	| (EventBase & { type: "message_end"; seq: number; text: string; toolCalls: ToolCall[] })
	/** A call the model asked for, announced before anything runs. */
	| (EventBase & { type: "tool_call"; seq: number; call: ToolCall })
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
	| (EventBase & { type: "run_end"; reason: RunEndReason; parkedReason?: ParkedReason });

/** A listener is never allowed to be the reason a run fails. */
export type RunEventListener = (event: RunEvent) => void;
