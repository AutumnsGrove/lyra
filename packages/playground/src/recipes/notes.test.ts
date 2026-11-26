import { expect, test } from "vitest";

import type { Tool } from "@autumnsgrove/lyra";

import {
	emptyToolTableState,
	notesDeleteTool,
	notesListTool,
	notesReadTool,
	notesWriteTool,
	type ToolTableState,
} from "./notes.js";

/**
 * The rows are in `docs/playground.md`: PGS26 and PGS27.
 *
 * The notes live in the recipe's state, which is what a resume rebuilds from the record
 * (decision 112), so a test drives the tools the way the loop does — `execute` for a
 * read, then the tool's `apply` for a write — and asserts on the state that comes out.
 */

function context(state: ToolTableState) {
	return {
		signal: new AbortController().signal,
		runId: "run-1",
		callId: "c1",
		callKey: "run-1\u0000c1",
		state,
	};
}

/** What the loop does with one call: execute, then apply when the result is not an error. */
async function call(
	tool: Tool,
	args: unknown,
	state: ToolTableState,
): Promise<{ outcome: Awaited<ReturnType<Tool["execute"]>>; state: ToolTableState }> {
	const outcome = await tool.execute(args, context(state));
	const applied =
		tool.apply === undefined || outcome.isError
			? state
			: (tool.apply(state, args, outcome) as ToolTableState);
	return { outcome, state: applied };
}

test("PGS26 a note is written, read back, listed and deleted", async () => {
	let state = emptyToolTableState();

	const written = await call(notesWriteTool(), { name: "milk", text: "two pints" }, state);
	state = written.state;
	expect(written.outcome.isError).toBe(false);

	const read = await call(notesReadTool(), { name: "milk" }, state);
	expect(read.outcome).toMatchObject({ isError: false, content: "two pints" });

	const listed = await call(notesListTool(), {}, state);
	// Sorted, so a list is the same line every time it is drawn.
	expect(listed.outcome.content).toBe("milk");

	const deleted = await call(notesDeleteTool(), { name: "milk" }, state);
	state = deleted.state;
	expect(deleted.outcome.isError).toBe(false);
	expect((await call(notesReadTool(), { name: "milk" }, state)).outcome.isError).toBe(true);
	expect((await call(notesListTool(), {}, state)).outcome.content).toBe("no notes");
});

test("PGS26 a write asks, and a read or a delete of nothing is an error the model can use", async () => {
	// The plan says writes ask and reads do not: a note is a change to the run's state,
	// and the approval card is how a person sees what the model wants to keep.
	for (const tool of [notesWriteTool(), notesDeleteTool()]) {
		expect(tool.policy).toBe("ask");
		expect(tool.apply).toBeDefined();
	}
	for (const tool of [notesReadTool(), notesListTool()]) {
		expect(tool.policy).toBe("allow");
		expect(tool.parallel).toBe(true);
		expect(tool.apply).toBeUndefined();
	}

	const state = emptyToolTableState();
	const missing = await call(notesReadTool(), { name: "nothing" }, state);
	expect(missing.outcome.isError).toBe(true);
	expect(missing.outcome.content).toContain("nothing");

	const deleting = await call(notesDeleteTool(), { name: "nothing" }, state);
	expect(deleting.outcome.isError).toBe(true);
	// An error changed nothing, so the state it hands back is the one it was given.
	expect(deleting.state).toBe(state);
});

test("PGS26 malformed arguments are refused by the schema, not stored", async () => {
	const state = emptyToolTableState();
	for (const tool of [notesWriteTool(), notesReadTool(), notesDeleteTool()]) {
		const outcome = await tool.execute(
			tool.spec.name === "notes_write" ? { name: "x" } : { text: "x" },
			context(state),
		);
		expect(outcome.isError, tool.spec.name).toBe(true);
	}
	// The schema also refuses an empty name, which would otherwise be a note nothing can
	// address.
	const empty = await notesWriteTool().execute({ name: "", text: "x" }, context(state));
	expect(empty.isError).toBe(true);
	expect(state.notes).toEqual({});
});

test("PGS26 a name inherited from Object.prototype is not a note", async () => {
	// The name is model-chosen and only length-checked, so `constructor` and `toString`
	// reach the lookup. A plain `{}` answers them with a function, which would make a
	// "read" return a non-string and a "delete" claim a note that never existed
	// (found in review on #92).
	const state = emptyToolTableState();
	for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
		const read = await call(notesReadTool(), { name }, state);
		expect(read.outcome.isError, name).toBe(true);
		expect(typeof read.outcome.content, name).toBe("string");

		const deleted = await call(notesDeleteTool(), { name }, state);
		expect(deleted.outcome.isError, name).toBe(true);
		// An error changed nothing, and the state is the one it was given.
		expect(deleted.state, name).toBe(state);
	}
	expect(state.notes).toEqual({});
});
