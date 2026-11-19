import { readFile } from "node:fs/promises";
import { join } from "node:path";
import YAML from "yaml";
import { expect, test } from "vitest";

/**
 * RN19 and RN20 in `docs/release-notes.md`. A workflow cannot be run from a
 * test, so what a test can hold is the shape that makes it safe: the key reaches
 * one step, the publish is guarded by a tag, and only one job may write or mint a
 * token. A regression in any of those is invisible in a passing release, which
 * is why they are read here rather than trusted.
 */
const WORKFLOW = join(import.meta.dirname, "..", "..", ".github", "workflows", "release.yml");

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, what: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new Error(`${what} is not a mapping in release.yml`);
	}
	return value;
}

function list(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) {
		throw new Error(`${what} is not a list in release.yml`);
	}
	return value;
}

function text(value: unknown, what: string): string {
	if (typeof value !== "string") {
		throw new Error(`${what} is not text in release.yml`);
	}
	return value;
}

/** The steps of one job, as records. */
function steps(jobs: Record<string, unknown>, job: string): Array<Record<string, unknown>> {
	return list(record(jobs[job], `jobs.${job}`)["steps"], `jobs.${job}.steps`).map((step, index) =>
		record(step, `jobs.${job}.steps[${index}]`),
	);
}

/** The command a step runs, or an empty string for a step that is an action. */
function command(step: Record<string, unknown>): string {
	const value = step["run"];
	return typeof value === "string" ? value : "";
}

test("RN19 the notes key reaches one step and nothing sets an npm token", async () => {
	const source = await readFile(WORKFLOW, "utf8");
	const doc = record(YAML.parse(source), "release.yml");
	const jobs = record(doc["jobs"], "jobs");

	// The credential is a model key with an allowance behind it. It is mapped to
	// the name the agent reads on the notes step only, because every other step is
	// code from this repository and none of them needs it.
	expect(source.split("PI_REVIEW_API_KEY")).toHaveLength(2);
	const carrying = Object.entries(jobs).flatMap(([name, job]) =>
		steps(jobs, name).filter(
			(step) => isRecord(step["env"]) && "OPENCODE_API_KEY" in step["env"],
		),
	);
	expect(carrying).toHaveLength(1);
	expect(text(carrying[0]?.["id"], "the notes step's id")).toBe("notes");

	// Publishing is trusted publishing over OIDC: a token left in the environment
	// would be used instead of the identity, which is the one failure a green
	// release would hide (decision 99).
	expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.NPM/);
});

test("RN20 a dry run never publishes, and only the release job may write", async () => {
	const doc = record(YAML.parse(await readFile(WORKFLOW, "utf8")), "release.yml");
	const jobs = record(doc["jobs"], "jobs");

	// Nothing in this workflow writes to the repository by default, and a dry run
	// is a rehearsal: it may read, run the gate and write a summary, nothing more.
	expect(doc["permissions"]).toEqual({ contents: "read" });
	expect(record(jobs["gate"], "jobs.gate")).not.toHaveProperty("permissions");
	expect(record(jobs["release"], "jobs.release")["permissions"]).toEqual({
		contents: "write",
		"id-token": "write",
	});

	const release = steps(jobs, "release");
	const guarded = (predicate: (step: Record<string, unknown>) => boolean) => {
		const step = release.find(predicate);
		expect(step, "no such step in release.yml").toBeDefined();
		return text(step?.["if"], "the step's if");
	};

	const publish = guarded((step) => command(step).includes("npm publish"));
	expect(publish).toContain("startsWith(github.ref, 'refs/tags/')");
	expect(publish).toContain("inputs.dry_run != true");

	const page = guarded((step) =>
		text(step["uses"] ?? "", "uses").startsWith("softprops/action-gh-release"),
	);
	expect(page).toContain("startsWith(github.ref, 'refs/tags/')");

	// A body is a courtesy: the install and the script may both fail without
	// stopping the publish, and the script's own 12 minutes sit inside this.
	const notes = release.find((step) => step["id"] === "notes");
	expect(notes?.["continue-on-error"]).toBe(true);
	expect(notes?.["timeout-minutes"]).toBe(15);
	const install = release.find((step) =>
		command(step).includes("npm install -g @earendil-works/pi-coding-agent"),
	);
	expect(install?.["continue-on-error"]).toBe(true);

	// The rehearsal itself: the body is shown where a reviewer reads it and kept,
	// and the release job still runs (a dry run is not a skip of everything).
	for (const step of release) {
		const summary = command(step).includes("GITHUB_STEP_SUMMARY");
		const artifact = text(step["uses"] ?? "", "uses").startsWith("actions/upload-artifact");
		if (summary || artifact) {
			expect(text(step["if"], "the step's if")).toContain("inputs.dry_run");
		}
	}

	// The gate command is the same one a pull request runs, so a tag cannot
	// publish what a pull request would have failed.
	const gate = steps(jobs, "gate").map(command).join("\n");
	expect(gate).toContain("pnpm run ci");
});
