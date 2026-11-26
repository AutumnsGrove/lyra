import { expect, test } from "vitest";
import { parse } from "yaml";

import { decodeScenario, fakeClock, runScenario } from "@autumnsgrove/lyra/testkit";

import { recipeCatalogue } from "./recipes/catalogue.js";

/**
 * The playground's own scenario files, in `scenarios/playground/`, run in-process
 * (issue #60, slice 5; SCN06).
 *
 * They live in a subdirectory because the three runners of `scenarios/*.yaml` give a
 * file only the testkit's recipes, and a playground file names `tool-table`. Vite hands
 * these over as text, so nothing here reads the disk, and the shop's `yaml` parses it.
 *
 * `sleep` returns at once: a scenario never calls `slow`, and a runner that could wait
 * on a real clock would be a test that sometimes takes five seconds.
 */

const files = import.meta.glob<string>("../../../scenarios/playground/*.yaml", {
	query: "?raw",
	import: "default",
	eager: true,
});

const settle = async (): Promise<void> => {};

function nameOf(path: string): string {
	return path.split("/").at(-1) ?? path;
}

test("PGS29 every playground scenario file is picked up", () => {
	// A guard against a glob that quietly matches nothing, which would make every test
	// below pass by having none of them.
	expect(Object.keys(files).length).toBeGreaterThanOrEqual(4);
});

for (const [path, raw] of Object.entries(files)) {
	const name = nameOf(path);

	test(`PGS29 the playground scenario ${name} is a file this runner understands`, () => {
		const decoded = decodeScenario(parse(raw));
		expect(decoded.ok ? [] : [decoded.error.message]).toEqual([]);
	});

	test(`PGS29 the playground scenario ${name} runs against the shipped recipe`, async () => {
		const decoded = decodeScenario(parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		const outcome = await runScenario(decoded.value, {
			recipes: recipeCatalogue(fakeClock(), { sleep: settle }),
		});
		// What the file expected of the events and the record, and that there is a record
		// at all: a runner handed the wrong recipe would fail here rather than pass empty.
		expect(outcome.problems).toEqual([]);
		expect(outcome.record).toBeDefined();
	});
}
