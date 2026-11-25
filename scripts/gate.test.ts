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

/**
 * Every step the gate is made of, in the order each half runs them.
 *
 * Written out rather than derived, because a list derived from `package.json`
 * would agree with any change to it, including deleting a step. This is the only
 * thing that notices a check dropped from **both** halves, which is the failure
 * that looks green: the tests would keep passing because the check stopped
 * running, not because it stopped failing.
 */
const GATE = {
	fast: [
		"format",
		"typecheck",
		"build",
		"importcheck",
		"matrixcheck",
		"workflowcheck",
		"build:example",
		"build:playground",
		"budget",
	],
	slow: ["test", "test:workers", "fuzz", "coverage"],
} as const;

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

	/**
	 * The halves together are the whole gate, in the order above. A step removed
	 * from one half and not added to the other shows up here; a step that belongs to
	 * both is caught by the same case, because it would appear twice.
	 */
	test("the two halves are exactly the gate, in order", async () => {
		const pkg = await scripts();
		expect(namedScripts(pkg["ci:fast"])).toEqual([...GATE.fast]);
		expect(namedScripts(pkg["ci:slow"])).toEqual([...GATE.slow]);
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
