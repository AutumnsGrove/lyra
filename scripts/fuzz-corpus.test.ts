import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

/**
 * The corpus guard (issue #41): every fuzz target either replays committed cases
 * or says why it does not yet.
 *
 * A fuzz target draws fresh cases and keeps nothing, so an input that failed last
 * week is gone. The corpus is what keeps it. This file is the reason a *new*
 * target cannot quietly arrive without one: the list below has to be edited, in a
 * change somebody reads, instead of the gap being invisible.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE = join(ROOT, "packages/lyra/src");

/**
 * Targets that do not replay a corpus yet, and what stands in the way. An entry
 * here is a debt with a reason, not a licence: remove it when the target is
 * converted, and the case below notices if the list goes stale.
 */
const NOT_YET: Record<string, string> = {
	"adapters/openai/sse.fuzz.test.ts": "the cases are byte streams; needs a text case shape first",
	"core/compaction.fuzz.test.ts":
		"the case is a whole record; needs the entry generators as literals",
	"protocol/answers.fuzz.test.ts": "not converted yet",
	"protocol/commands.fuzz.test.ts": "not converted yet",
	"protocol/events.fuzz.test.ts": "not converted yet",
	"record/load.fuzz.test.ts": "the case is a header plus entries; needs them as literals",
	"record/truncate.fuzz.test.ts":
		"the case is a whole entry; needs the entry generators as literals",
};

async function fuzzTargets(dir = PACKAGE): Promise<string[]> {
	const found: string[] = [];
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			found.push(...(await fuzzTargets(path)));
		} else if (entry.name.endsWith(".fuzz.test.ts")) {
			found.push(relative(PACKAGE, path).split("\\").join("/"));
		}
	}
	return found.sort();
}

/** The corpus module a target imports, if it imports one. */
function corpusImport(source: string): string | undefined {
	const match = source.match(/from "\.\/corpus\/([a-zA-Z0-9._-]+)\.testing\.js"/);
	return match?.[1];
}

describe("every fuzz target", () => {
	test("finds the targets it is checking", async () => {
		// An empty list would pass every case below without checking anything.
		expect((await fuzzTargets()).length).toBeGreaterThan(5);
	});

	test("replays a committed corpus, or is named in the list with a reason", async () => {
		for (const target of await fuzzTargets()) {
			const source = await readFile(join(PACKAGE, target), "utf8");
			const corpus = corpusImport(source);
			if (corpus === undefined) {
				expect(
					NOT_YET[target],
					`${target} replays no corpus and is not in NOT_YET`,
				).toBeDefined();
				continue;
			}
			const modulePath = join(PACKAGE, dirname(target), "corpus", `${corpus}.testing.ts`);
			const module = await readFile(modulePath, "utf8");
			// The cases live in a module so the compiler checks their shape; a module
			// that exports nothing would make `replay` throw "no cases" at run time,
			// but this catches it before the suite does.
			expect(module, `${modulePath} exports no cases`).toContain("export const cases");
		}
	});

	test("does not leave a converted target on the not-yet list", async () => {
		for (const target of await fuzzTargets()) {
			const source = await readFile(join(PACKAGE, target), "utf8");
			if (corpusImport(source) !== undefined) {
				expect(
					NOT_YET[target],
					`${target} replays a corpus but is still in NOT_YET`,
				).toBeUndefined();
			}
		}
	});
});
