import { expect, test } from "vitest";
import { parse } from "yaml";

import { createOpenAIChatModel } from "./adapters/openai/model.js";
import { fakeModelServer } from "./testkit/fake-model-server.js";
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

	test(`SCN04 the scenario ${name} runs the same through the fake server`, async () => {
		const decoded = decodeScenario(parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		// The third level decision 63 asks for: the same file, through a real adapter
		// and a fake server, which is the wire a host would see.
		let asked = 0;
		const outcome = await runScenario(decoded.value, {
			makeModel: (turns, clock, options) => {
				const model = createOpenAIChatModel({
					baseUrl: "https://fake.test/v1",
					model: "scripted/model",
					secrets: { get: async () => "not-a-real-key" },
					keyName: "MODEL_KEY",
					fetch: fakeModelServer(turns, {
						...(options.summaries === undefined
							? {}
							: { summaries: options.summaries }),
						...(options.position === undefined ? {} : { position: options.position }),
					}),
					clock,
				});
				return {
					complete: (request) => {
						asked += 1;
						return model.complete(request);
					},
				};
			},
		});
		// The wire really was used: the same expectations could otherwise pass by
		// falling back to the in-process model.
		expect(asked).toBeGreaterThan(0);
		expect(outcome.problems).toEqual([]);
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
