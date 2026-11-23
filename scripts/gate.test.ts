import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { readWorkflow, ROOT, runsIn } from "./workflows.ts";

/**
 * The gate: what `pnpm run ci` runs, and the two jobs that run it in CI
 * (issue #37).
 *
 * Issue #37 split one serial job into a fast half and a slow half, so a
 * whitespace failure reports in about a minute instead of queueing behind
 * workerd. The split is only safe while the two halves still add up to the whole
 * gate, which is what these cases protect: a step added to neither, or dropped
 * from both, is a check that quietly stopped running.
 */

interface Manifest {
	scripts: Record<string, string>;
}

async function scripts(): Promise<Record<string, string>> {
	const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as Manifest;
	return pkg.scripts;
}

/** The scripts a composed command names, in order, with pnpm's two spellings removed. */
function namedScripts(command: string | undefined): string[] {
	return (command ?? "")
		.split("&&")
		.map((step) => step.trim().replace(/^pnpm (run )?/, ""))
		.filter((step) => step !== "");
}

describe("the gate", () => {
	test("ci runs the fast half and then the slow half", async () => {
		const pkg = await scripts();
		// In this order: the cheap checks speak first, so a formatting failure is
		// never hidden behind a workerd suite. One command, so a local run is still
		// the whole gate (`AGENTS.md`, "Definition of done").
		expect(pkg.ci).toBe("pnpm run ci:fast && pnpm run ci:slow");
		expect(pkg["ci:fast"], "ci:fast is missing").toBeDefined();
		expect(pkg["ci:slow"], "ci:slow is missing").toBeDefined();
	});

	test("no step belongs to both halves", async () => {
		const pkg = await scripts();
		const fast = namedScripts(pkg["ci:fast"]);
		const slow = namedScripts(pkg["ci:slow"]);
		expect(fast.filter((step) => slow.includes(step))).toEqual([]);
		// Each half must run something, or a task-list typo turns half the gate into
		// a no-op that passes.
		expect(fast.length).toBeGreaterThan(0);
		expect(slow.length).toBeGreaterThan(0);
	});

	test("every step the halves name is a script that exists", async () => {
		const pkg = await scripts();
		for (const half of ["ci:fast", "ci:slow"]) {
			for (const step of namedScripts(pkg[half])) {
				expect(pkg[step], `${half} names ${step}, which is not a script`).toBeDefined();
			}
		}
	});
});

describe("the gate runs the gate", () => {
	/**
	 * A job runs the same command a person runs, so CI and the local gate cannot
	 * drift. The halves, not `pnpm run ci`: the point of the split is that the two
	 * jobs run side by side, and a job running the whole gate would run the other
	 * half a second time.
	 */
	test("ci.yml has one job per half, each running its own script", async () => {
		const workflow = await readWorkflow("ci.yml");
		const runs = runsIn(workflow).filter((run) => run.startsWith("pnpm run ci"));
		expect(runs.sort()).toEqual(["pnpm run ci:fast", "pnpm run ci:slow"]);
	});
});
