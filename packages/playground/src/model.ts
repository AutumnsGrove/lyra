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
		const answered = request.messages.filter((message) => message.role === "assistant").length;
		const reply: ModelReply = {
			// A resumed segment has already been answered once, so it answers with text
			// rather than a second `finish`: a run that ended cannot finish again.
			text: answered === 0 ? "" : "The shell has nothing to do.",
			toolCalls: answered === 0 ? [{ id: "c1", name: "finish", arguments: "{}" }] : [],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: answered === 0 ? "tool_calls" : "stop",
			model: PLACEHOLDER_MODEL_NAME,
		};
		return ok(reply);
	},
};
