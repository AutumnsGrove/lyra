/**
 * The model slot the shell deploys with (issue #60, slice 1).
 *
 * Slice 1 is the shell that deploys: it has to answer a `start` so the front door, the
 * object, the record and the protocol can be proved on a real deployment, and a real
 * model is slice 2's job. So this slot decides nothing and calls `finish` on its first
 * turn, which ends the run at once and needs no key and no network.
 *
 * It reports zero tokens and no cost rather than inventing a number: slice 7's day cap
 * treats a reply with no cost as an unpriced day, and a placeholder that claimed a
 * price would hide that it never called a model.
 */

import { ok, type ModelReply, type ModelSlot } from "@autumnsgrove/lyra";

/** The name every reply reports, so the record shows which model answered. */
export const PLACEHOLDER_MODEL_NAME = "playground-placeholder";

export const PLACEHOLDER_MODEL: ModelSlot = {
	async complete(request) {
		// Every segment calls `finish`, including a follow-up's. A segment is its own run
		// of the loop (decision 44), so a finished one does not forbid the next its finish;
		// answering with text instead was a live bug, because a segment that never finishes
		// is what the stuck safeguard parks (found in review on #81).
		void request;
		const reply: ModelReply = {
			text: "",
			toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "tool_calls",
			model: PLACEHOLDER_MODEL_NAME,
		};
		return ok(reply);
	},
};
