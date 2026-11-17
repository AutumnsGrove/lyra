import { expect, test } from "vitest";
import { parse } from "yaml";

import { decodeScenario, runScenario } from "./testkit/scenario.js";

/**
 * The scenarios in `scenarios/`, run in-process (docs/engineering-practices.md,
 * SCN01; decision 63). The same files run over the protocol in step 6, which is
 * why they live at the repository root and carry no in-process words.
 *
 * `src/` may not import `node:fs`, so Vite hands the files over as raw text and
 * `yaml` parses them. Both are test-only, and `packages/lyra/testing/glob.d.ts`
 * is the declaration that lets the test see `import.meta.glob` without the
 * library build seeing it too.
 *
 * `matrixcheck` reads test titles literally, so these titles name the file rather
 * than a row; the runner's rows are cited in `testkit/scenario.test.ts`.
 */

const files = import.meta.glob<string>("../../../scenarios/*.yaml", {
	query: "?raw",
	import: "default",
	eager: true,
});

function nameOf(path: string): string {
	return path.split("/").at(-1) ?? path;
}

test("every scenario file in the repository is picked up", () => {
	// A guard against a glob that silently matches nothing, which would pass
	// every test below by having none of them.
	expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
});

for (const [path, raw] of Object.entries(files)) {
	const name = nameOf(path);

	test(`the scenario ${name} is a file this runner understands`, () => {
		const decoded = decodeScenario(parse(raw));
		expect(decoded.ok ? [] : [decoded.error.message]).toEqual([]);
	});

	test(`the scenario ${name} runs the way its expectations say`, async () => {
		const decoded = decodeScenario(parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		const outcome = await runScenario(decoded.value);
		expect(outcome.problems).toEqual([]);
	});
}
