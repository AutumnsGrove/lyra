/**
 * The one recipe the shell ships (issue #60, slice 1).
 *
 * It has a single tool — `finish` with no done-check, because there is no work whose
 * completion could be checked — so a run against the deployment has a beginning, a
 * record and an end and nothing else. Slice 2's `tool-table` is the first recipe with
 * tools that do something.
 *
 * A plain `Recipe` rather than `defineRecipe`, like the example Worker: there is no
 * input to check and no state to build, so the ceremony would add a schema nobody
 * reads.
 */

import { createFinishTool, type Recipe } from "@autumnsgrove/lyra";

export const shellRecipe: Recipe = {
	name: "shell",
	version: 1,
	instructions:
		"You are Lyra, running in her playground. There is nothing to do yet: call finish.",
	tools: [createFinishTool({ check: () => ({ ok: true }) })],
};
