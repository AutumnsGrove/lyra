/**
 * Rebuilding a recipe's state from the record (docs/recipes-and-tools.md, TOL07 to
 * TOL11; decision 112).
 *
 * The record is the only place a run's progress lives (decision 32), and a run's
 * state is what its tools build as it goes: the page, and the handle table that
 * names real commits. A resume therefore runs the recipe's `setup` again and then
 * walks the saved results in order, handing each one to its tool's `apply`. That is
 * the same call a live run makes after a successful execute, so there is one code
 * path and live and replayed state cannot drift.
 *
 * A result that is an error never changed anything, so it is skipped; so is a call
 * whose arguments the tool's own schema refuses, because the live run never ran it.
 */

import { activePath } from "../record/replay.js";
import type { RecordEntry } from "../record/entries.js";
import { usableArguments } from "./execute-tools.js";
import type { Tool, ToolOutcome } from "./tool.js";

export function replayState<S>(
	initial: S,
	entries: readonly RecordEntry[],
	tools: ReadonlyMap<string, Tool>,
): S {
	let state = initial;
	/** The calls of the assistant turns seen so far, by id, so a result finds its own. */
	const calls = new Map<string, { name: string; arguments: string }>();

	for (const entry of activePath(entries)) {
		if (entry.type === "assistant_message") {
			for (const call of entry.toolCalls) {
				calls.set(call.id, { name: call.name, arguments: call.arguments });
			}
			continue;
		}
		if (entry.type !== "tool_message" || entry.isError) {
			continue;
		}
		const call = calls.get(entry.toolCallId);
		if (call === undefined) {
			continue;
		}
		const tool = tools.get(call.name);
		if (tool?.apply === undefined) {
			continue;
		}
		const args = usableArguments(tool, call.arguments);
		if (!args.ok) {
			continue;
		}
		const outcome: ToolOutcome = { isError: false, content: entry.content };
		if (entry.details !== undefined) {
			outcome.details = entry.details;
		}
		// The recipe's own `apply` returns its own state type; this is the seam where
		// the core, which does not know that type, carries it through.
		state = tool.apply(state, args.value, outcome) as S;
	}
	return state;
}
