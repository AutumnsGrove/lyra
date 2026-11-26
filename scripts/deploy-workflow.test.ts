import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";

import { ROOT, permissionsOf, readWorkflow, triggers, type Workflow } from "./workflows.ts";

/**
 * The rows are in `docs/playground.md`: PGS43 and PGS44.
 *
 * The deploy workflow is the one thing in this repository that changes the world from CI,
 * so its shape is asserted rather than reviewed once: what triggers it, what it may write,
 * and that the smoke job cannot run before the deploy it is checking.
 */

function jobOf(workflow: Workflow, name: string): Record<string, unknown> {
	const job = (workflow.jobs as Record<string, Record<string, unknown>> | undefined)?.[name];
	expect(job, `the workflow has no ${name} job`).toBeDefined();
	return job ?? {};
}

function stepTexts(job: Record<string, unknown>): string {
	return JSON.stringify(job);
}

test("PGS43 the playground deploys from main, after the gate, and writes nothing", async () => {
	const workflow = await readWorkflow("deploy.yml");
	const trigger = workflow.on as
		| { workflow_run?: { workflows?: string[]; types?: string[]; branches?: string[] } }
		| undefined;

	// Only a green `ci` on `main` deploys, or a person asking by hand. A pull request never
	// does, which is why the trigger is `workflow_run` rather than `push`.
	expect(trigger?.workflow_run?.workflows).toEqual(["ci"]);
	expect(trigger?.workflow_run?.types).toEqual(["completed"]);
	expect(trigger?.workflow_run?.branches).toEqual(["main"]);
	expect(triggers(workflow)).not.toContain("pull_request");

	const deploy = jobOf(workflow, "deploy");
	// The condition that makes "after the gate" true, spelled out rather than implied.
	const condition = String(deploy["if"]);
	expect(condition).toContain("conclusion == 'success'");
	expect(condition).toContain("workflow_dispatch");
	// A `pull_request` run's head branch is the PR's source branch, so a fork could name its
	// branch `main`, pass its own gate and have this job deploy its code with the Cloudflare
	// credential. The run has to be a push, in this repository (found in review on #103).
	expect(condition).toContain("event == 'push'");
	expect(condition).toContain("repository.full_name == github.repository");
	// The commit `ci` passed on, not whatever main points at now.
	expect(stepTexts(deploy)).toContain("workflow_run.head_sha");

	// The deploy needs the two Cloudflare secrets and nothing else; the Worker's own
	// secrets survive a deploy and are deliberately not re-set here.
	const text = stepTexts(deploy);
	expect(text).toContain("secrets.CLOUDFLARE_API_TOKEN");
	expect(text).toContain("secrets.CLOUDFLARE_ACCOUNT_ID");
	expect(text).toContain("wrangler deploy --config packages/playground/wrangler.jsonc");

	// Nothing here writes to the repository.
	const writes = Object.values(workflow.jobs ?? {})
		.flatMap((job) => Object.entries(permissionsOf(workflow, job)))
		.filter(([, level]) => level === "write");
	expect(writes).toEqual([]);
});

test("PGS44 the smoke job runs after the deploy and drives it with a script", async () => {
	const workflow = await readWorkflow("deploy.yml");
	const smoke = jobOf(workflow, "smoke");

	expect(smoke["needs"]).toBe("deploy");
	expect(stepTexts(smoke)).toContain("scripts/playground-smoke.mjs");
	// The three names the driver reads, and the tenant as a var rather than a secret.
	const text = stepTexts(smoke);
	for (const name of [
		"PLAYGROUND_SMOKE_TOKEN",
		"PLAYGROUND_SCRIPT_TOKEN",
		"secrets.LYRA_PLAYGROUND_SMOKE_TOKEN",
		"secrets.LYRA_PLAYGROUND_SCRIPT_TOKEN",
		"vars.PLAYGROUND_SMOKE_TENANT",
	]) {
		expect(text, name).toContain(name);
	}
	// A smoke job that could hang is a deploy that never reports: both jobs carry a ceiling.
	for (const name of ["deploy", "smoke"]) {
		expect(jobOf(workflow, name)["timeout-minutes"], name).toBeTypeOf("number");
	}

	// Nothing secret-shaped is written into the workflow itself.
	const raw = await readFile(join(ROOT, ".github/workflows/deploy.yml"), "utf8");
	expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
	expect(raw).not.toMatch(/[A-Za-z0-9_-]{40,}/);
});
