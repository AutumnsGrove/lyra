/**
 * Notes a run can keep (issue #60, slice 5).
 *
 * The notes are the recipe's **state** rather than a separate store, because that is the
 * only state a resume rebuilds: the record holds each call's result, `setup` runs again,
 * and every successful `apply` is replayed in order (decision 112). A note written before
 * an eviction is therefore a note the next segment can read, and nothing new is added to
 * Lyra for the rig's benefit.
 *
 * Writes carry an `apply`, so they cannot run beside another call (decision 154) and they
 * ask a person (`risk: "changes"`): keeping a note is a change to what the run holds, and
 * the card is where a person sees it. Reads are pure, allowed, and parallel, which is what
 * makes a group of lookups show up as several rows in flight.
 */

import { defineTool, type Tool, type ToolContext } from "@autumnsgrove/lyra";

/** What `tool-table` starts with, and what a resume rebuilds to before replaying. */
export interface ToolTableState {
	notes: Record<string, string>;
}

export function emptyToolTableState(): ToolTableState {
	return { notes: {} };
}

/** A note's name is short and non-empty: it is how a read addresses it. */
const NAME = {
	type: "object",
	properties: { name: { type: "string", minLength: 1, maxLength: 80 } },
	required: ["name"],
} as const;

const TEXT = 4_000;

export function notesWriteTool(): Tool {
	return defineTool({
		name: "notes_write",
		description: "Keep a short note under a name, so a later step can read it back.",
		parameters: {
			type: "object",
			properties: {
				...NAME.properties,
				text: { type: "string", minLength: 1, maxLength: TEXT },
			},
			required: ["name", "text"],
		},
		// A write is a change, so it asks and it is not repeatable for free. The policy is
		// written out as well as the risk label, because the label sets the default and
		// this tool's behaviour should not depend on a default staying where it is.
		policy: "ask",
		risk: "changes",
		safeToRepeat: false,
		execute: async (args) => ({
			isError: false,
			content: `the note "${args.name}" was kept`,
			details: { name: args.name },
		}),
		apply: (state: ToolTableState, args, outcome) => {
			if (outcome.isError) {
				return state;
			}
			return { ...state, notes: { ...state.notes, [args.name]: args.text } };
		},
	});
}

export function notesReadTool(): Tool {
	return defineTool({
		name: "notes_read",
		description: "Read the note kept under a name.",
		parameters: NAME,
		// Reading changes nothing, so it is free to repeat and can run beside another read.
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (args, ctx: ToolContext<ToolTableState>) => {
			const note = ctx.state.notes[args.name];
			return note === undefined
				? {
						isError: true,
						content: `there is no note called "${args.name}"`,
						details: { name: args.name, known: Object.keys(ctx.state.notes) },
					}
				: {
						isError: false,
						content: note,
						details: { name: args.name, length: note.length },
					};
		},
	});
}

export function notesListTool(): Tool {
	return defineTool({
		name: "notes_list",
		description: "List the names of the notes this run has kept.",
		parameters: { type: "object", properties: {} },
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (_args, ctx: ToolContext<ToolTableState>) => {
			const names = Object.keys(ctx.state.notes).sort();
			return {
				isError: false,
				// Sorted, so the same set is the same line every time it is drawn.
				content: names.length === 0 ? "no notes" : names.join("\n"),
				details: { count: names.length },
			};
		},
	});
}

export function notesDeleteTool(): Tool {
	return defineTool({
		name: "notes_delete",
		description: "Delete the note kept under a name.",
		parameters: NAME,
		policy: "ask",
		risk: "changes",
		safeToRepeat: false,
		execute: async (args, ctx: ToolContext<ToolTableState>) => {
			const note = ctx.state.notes[args.name];
			return note === undefined
				? { isError: true, content: `there is no note called "${args.name}" to delete` }
				: { isError: false, content: `the note "${args.name}" was deleted` };
		},
		apply: (state: ToolTableState, args, outcome) => {
			// An error changed nothing, and an unknown name is exactly that: the state it
			// was given comes back untouched.
			if (outcome.isError || state.notes[args.name] === undefined) {
				return state;
			}
			const notes = { ...state.notes };
			delete notes[args.name];
			return { ...state, notes };
		},
	});
}
