/**
 * The recipes this Worker ships (issue #60, slice 3).
 *
 * One map, built from the clock a session runs on, so the picker's list and the map a
 * `start` is answered from cannot disagree: a page that offered a recipe the session did
 * not carry would turn a person's first click into `not_found`, and a page that hid one
 * would leave a recipe nobody could reach. The Worker's `/api/recipes` reads the keys of
 * this map rather than a list of its own.
 */

import type { Clock, Recipe } from "@autumnsgrove/lyra";

import { shellRecipe } from "./shell.js";
import { toolTableRecipe } from "./tool-table.js";

export interface CatalogueOptions {
	/** The wait `slow` uses; a test passes one that returns at once. */
	sleep?: (ms: number) => Promise<void>;
	/** The `fetch` the page tools use; a test passes a fake. */
	fetch?: import("./network.js").PageFetch;
}

export function recipeCatalogue(
	clock: Clock,
	options: CatalogueOptions = {},
): ReadonlyMap<string, Recipe> {
	// Keyed by the recipe's own name, not the factory's: the factory and the recipe
	// happen to agree today, and the test that asserts these keys is what keeps it so.
	const toolTable = toolTableRecipe({
		clock,
		...(options.sleep === undefined ? {} : { sleep: options.sleep }),
		...(options.fetch === undefined ? {} : { fetch: options.fetch }),
	});
	return new Map([
		[shellRecipe.name, shellRecipe],
		[toolTable.name, toolTable],
	]);
}
