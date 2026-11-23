import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import { handWrittenWorkflows } from "./workflowcheck.ts";
import { permissionsOf, readWorkflow, ROOT, triggers } from "./workflows.ts";

/**
 * The workflow files, and the dependabot config that keeps their actions
 * current (issues #36 and #38).
 *
 * Each case states a rule that is easy to break by editing YAML in a hurry, and
 * the rules are the reasons behind the config rather than its text: a workflow
 * with no `permissions:` block runs with the repository default, and a group
 * that swallows a major bump is the Nova #110 mistake. Nothing here asserts on
 * file contents, so reformatting cannot make a case fail and re-breaking it
 * cannot make one pass.
 */

/**
 * The writes each hand-written workflow has been given, and nothing else. A new
 * one has to be added here, in the same change that asks for it, so an extra
 * write is a decision somebody made rather than a line that slipped in.
 *
 * `id-token: write` is the odd one: it is not a repository scope but the ability
 * to mint an OIDC token, which `claude.yml` needs for its credential exchange and
 * `release.yml` needs for npm trusted publishing. It is written here rather than
 * left implicit because it is the strongest grant in the directory.
 */
const ALLOWED_WRITES: Record<string, string[]> = {
	"claude-code-review.yml": ["issues", "pull-requests"],
	"claude.yml": ["id-token"],
	"nightly.yml": ["issues"],
	"release.yml": ["contents", "id-token"],
};

describe("workflow permissions", () => {
	test("every hand-written workflow declares permissions", async () => {
		for (const file of await handWrittenWorkflows()) {
			const workflow = await readWorkflow(basename(file));
			const declaredAtJob = Object.values(workflow.jobs ?? {}).some(
				(job) => job.permissions !== undefined,
			);
			expect(
				workflow.permissions ?? (declaredAtJob ? {} : undefined),
				`${basename(file)} has no permissions block, so it runs with the repository default`,
			).toBeDefined();
		}
	});

	/**
	 * The gate and the release job both say "nothing here writes to the repository
	 * unless a job says so". This is what makes that sentence true of the
	 * directory rather than of one file.
	 */
	test("no hand-written workflow grants a write it was not given", async () => {
		for (const file of await handWrittenWorkflows()) {
			const workflow = await readWorkflow(basename(file));
			const allowed = ALLOWED_WRITES[basename(file)] ?? [];
			// A job's permissions replace the workflow's, so every job is read and the
			// writes are the union of what any of them can do.
			const writes = Object.values(workflow.jobs ?? {})
				.flatMap((job) => Object.entries(permissionsOf(workflow, job)))
				.filter(([, level]) => level === "write")
				.map(([scope]) => scope);
			expect(
				[...new Set(writes)].sort(),
				`${basename(file)} grants writes ${writes.join(", ")}`,
			).toEqual([...allowed].sort());
		}
	});
});

describe("pull request runs", () => {
	/**
	 * A push supersedes the run it replaced. Without the group, two pipelines
	 * report on the same commit and the older one answers a question nobody is
	 * asking any more. For the review bots this matters more than speed: a push
	 * made the moment the first review lands cancels the second one mid-read
	 * (`AGENTS.md`, "Commits and pull requests").
	 */
	test("every pull request workflow cancels the run it supersedes", async () => {
		for (const file of await handWrittenWorkflows()) {
			const workflow = await readWorkflow(basename(file));
			if (!triggers(workflow).includes("pull_request")) {
				continue;
			}
			expect(workflow.concurrency?.["cancel-in-progress"], basename(file)).toBeDefined();
			expect(workflow.concurrency?.group, basename(file)).toBeDefined();
		}
	});
});

describe("dependabot", () => {
	interface Update {
		"package-ecosystem"?: string;
		groups?: Record<string, { "update-types"?: string[] }>;
	}

	async function updates(): Promise<Update[]> {
		const config = parse(await readFile(join(ROOT, ".github/dependabot.yml"), "utf8")) as {
			updates: Update[];
		};
		return config.updates;
	}

	test("watches both ecosystems this repository moves on", async () => {
		const ecosystems = (await updates()).map((update) => update["package-ecosystem"]);
		expect(ecosystems.sort()).toEqual(["github-actions", "npm"]);
	});

	/**
	 * Nova learned this one: without the update-type filter, a group swallowed
	 * three majors of `upload-artifact` into a single pull request (#110), which
	 * cannot be reviewed as one change. A major can rename an input or move a
	 * runtime, so it gets its own pull request.
	 */
	test("groups take minor and patch bumps, never a major", async () => {
		for (const update of await updates()) {
			const groups = Object.values(update.groups ?? {});
			expect(groups.length, `${update["package-ecosystem"]} has no group`).toBeGreaterThan(0);
			for (const group of groups) {
				expect(group["update-types"], `${update["package-ecosystem"]} group`).toEqual([
					"minor",
					"patch",
				]);
			}
		}
	});
});
