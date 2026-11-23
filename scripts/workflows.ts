import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

/**
 * Reading the CI configuration, for the cases that guard it (`workflows.test.ts`
 * and `gate.test.ts`).
 *
 * These are not part of the package and never reach a caller: they exist so the
 * workflow YAML has a test suite at all, which is the one part of this
 * repository that runs on every change and is otherwise read by nobody.
 */

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOWS = join(ROOT, ".github/workflows");

export interface Step {
	uses?: string;
	run?: string;
}

export interface Job {
	uses?: string;
	/** The condition that decides whether the job runs at all. */
	if?: string;
	steps?: Step[];
	permissions?: Record<string, string>;
}

export interface Workflow {
	name?: string;
	on?: unknown;
	permissions?: Record<string, string>;
	concurrency?: { group?: string; "cancel-in-progress"?: unknown };
	jobs?: Record<string, Job>;
}

/** Write the parsed YAML as text, so a failing case names the file it read. */
export async function readWorkflow(file: string): Promise<Workflow> {
	return parse(await readFile(join(WORKFLOWS, file), "utf8")) as Workflow;
}

/** The events a workflow listens to, in either of the two spellings `on:` takes. */
export function triggers(workflow: Workflow): string[] {
	const on = workflow.on;
	if (typeof on === "string") {
		return [on];
	}
	if (Array.isArray(on)) {
		return on.map(String);
	}
	return Object.keys((on ?? {}) as Record<string, unknown>);
}

/**
 * The permissions a job runs with. `permissions:` is accepted at the workflow and
 * at the job, and the job wins, so either place counts.
 */
export function permissionsOf(workflow: Workflow, job: Job): Record<string, string> {
	return (job.permissions ?? workflow.permissions ?? {}) as Record<string, string>;
}

/** The `run:` command of every step in a workflow, in order. */
export function runsIn(workflow: Workflow): string[] {
	return Object.values(workflow.jobs ?? {})
		.flatMap((job) => job.steps ?? [])
		.map((step) => step.run ?? "")
		.filter((run) => run !== "");
}
