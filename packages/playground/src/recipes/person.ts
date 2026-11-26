/**
 * The two tools that need somebody else (issue #60, slice 5).
 *
 * An approval asks whether a call may run; a question asks for something only a person
 * knows, and both are the same mechanism (decision 34). A proposal is the other half:
 * the run finishes with a result and a person decides what to do with it later (decision
 * 52). Neither tool invents an answer, which is what makes them worth having in a rig.
 */

import { createProposeTool, defineTool, type Tool } from "@autumnsgrove/lyra";

const SUMMARY_PAYLOAD = {
	type: "object",
	properties: { summary: { type: "string", minLength: 1, maxLength: 2_000 } },
	required: ["summary"],
} as const;

/** Asks a person a question; the answer becomes this call's result (APR14). */
export function askPersonTool(): Tool {
	return defineTool({
		name: "ask_person",
		description: "Ask the person one question, and use their answer to carry on.",
		parameters: {
			type: "object",
			properties: { question: { type: "string", minLength: 1, maxLength: 500 } },
			required: ["question"],
		},
		// Nothing changes, so it may be allowed without an approval: the question itself
		// is what stops the run, and a person is the only one who can answer it.
		policy: "allow",
		safeToRepeat: false,
		execute: async (args) => ({
			isError: false,
			content: "the person answered",
			ask: {
				kind: "question",
				title: "the run needs an answer",
				message: args.question,
			},
		}),
	});
}

/** Leaves a summary for a person to accept or reject after the run has ended. */
export function proposeSummaryTool(): Tool {
	return createProposeTool({
		name: "propose_summary",
		description:
			"Propose a summary of what was done, for a person to accept or reject once the run has ended.",
		payload: SUMMARY_PAYLOAD,
	});
}
