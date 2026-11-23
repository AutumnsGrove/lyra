import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse } from "yaml";
import { describe, expect, test } from "vitest";

import { handWrittenWorkflows } from "./workflowcheck.ts";
import { permissionsOf, readWorkflow, ROOT, triggers, type Workflow } from "./workflows.ts";

/**
 * A folded (`>-`) condition reaches us with its line breaks still in it, so a
 * clause that wrapped differently would read as a different clause. Comparing
 * the collapsed text is the difference between a case about the guard and a
 * case about how the guard happens to be indented today.
 */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

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

describe("timeouts", () => {
	/**
	 * The release gate runs `pnpm run ci`, which is the two halves of `ci.yml` in
	 * sequence, so its ceiling has to cover what each half is given. The two numbers
	 * are in different files and nothing else relates them: a tag timing out while
	 * the pull request passed would be the worst place to find out (found in
	 * review).
	 */
	test("the release gate can take as long as both halves together", async () => {
		const ci = await readWorkflow("ci.yml");
		const release = await readWorkflow("release.yml");
		const minutes = (workflow: Workflow, job: string): number => {
			const value = (workflow.jobs?.[job] as { "timeout-minutes"?: number } | undefined)?.[
				"timeout-minutes"
			];
			expect(value, `${job} has no timeout`).toBeTypeOf("number");
			return value ?? 0;
		};
		const halves = minutes(ci, "fast") + minutes(ci, "slow");
		expect(minutes(release, "gate")).toBeGreaterThanOrEqual(halves);
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

	/**
	 * GitHub gives a workflow triggered by Dependabot no repository secrets, so
	 * both reviewers start on that pull request and die before they can read
	 * anything: `pi-review` exits 1 and posts no artifact, and the Claude action
	 * refuses a non-human actor by policy. A red check on every weekly bump is a
	 * red check everybody learns to ignore, which is exactly the habit the rest
	 * of `AGENTS.md` spends a section trying to prevent, so neither reader runs
	 * on an author GitHub calls a bot (decision 151).
	 *
	 * The clause is asserted by its exact text because the two ways of writing it
	 * are not the same guard. `!= 'Bot'` is true when no pull request is in the
	 * event at all, which is what keeps an `@pi` mention working on any pull
	 * request: `pull_request` is absent from `issue_comment`, so the comparison
	 * sees null and lets the run through. `== 'User'` reads as stricter and is
	 * the one that would silently stop every mention, so the exact clause is the
	 * assertion and a rewrite is what has to justify itself.
	 */
	test("neither reviewer runs on a pull request from a bot", async () => {
		const reviewers = ["claude-code-review.yml", "pi-review.yml"];
		const skipsBots = "github.event.pull_request.user.type != 'Bot'";
		const mentionHalf = "github.event_name == 'issue_comment'";
		for (const file of reviewers) {
			const workflow = await readWorkflow(file);
			expect(
				triggers(workflow),
				`${file} no longer runs on pull requests, so nothing is reviewed`,
			).toContain("pull_request");

			const conditions = Object.values(workflow.jobs ?? {}).map((job) =>
				collapse(job.if ?? ""),
			);
			const condition = conditions.find((text) => text.includes(skipsBots));
			expect(
				condition,
				`${file} reviews pull requests from bots, which fail on the secret GitHub withholds`,
			).toBeDefined();
			if (condition === undefined) {
				continue;
			}

			/**
			 * The clause has to be in the pull request half, not merely somewhere in the
			 * condition. `pi-review`'s is `(pull request) || (@pi mention)`, and a case
			 * satisfied by any occurrence would pass while the pull request half lost
			 * its copy, because the mention half is where a copy would most plausibly be
			 * moved to (found in review). The mention alternative is where the second
			 * half starts, so the clause has to come before it.
			 *
			 * A condition with no mention half is a plain `&&` chain, and there the
			 * failure is the opposite one: the clause is present but joined with `||`,
			 * which makes it a way in rather than a requirement, and the job starts on
			 * every bot's pull request while this case still passes (found in the next
			 * round of review). The Claude job has no `||` today and does not want one,
			 * so the absence is the assertion.
			 */
			const secondHalf = condition.indexOf(mentionHalf);
			if (secondHalf !== -1) {
				expect(
					condition.indexOf(skipsBots),
					`${file} mentions the bot clause only outside the pull request half, so a bot's pull request still starts it`,
				).toBeLessThan(secondHalf);
			} else {
				expect(
					condition,
					`${file} joins the bot clause with ||, so it is an alternative rather than a requirement`,
				).not.toContain("||");
			}
		}

		/**
		 * `@pi` is the one way a bot's pull request can still be reviewed, because
		 * a person asked for it on the thread, and that path carries its own
		 * actor guard: the commenter has to be an owner, member or collaborator.
		 * Dropping it would let a stranger on a fork reach the reviewer by
		 * commenting, so it is asserted here rather than left to the renderer.
		 */
		const piReview = collapse(
			Object.values((await readWorkflow("pi-review.yml")).jobs ?? {})
				.map((job) => job.if ?? "")
				.join(" "),
		);
		expect(piReview).toContain("github.event.comment.user.type != 'Bot'");
	});
});

/**
 * `pi-review.yml` is generated from `.github/pi-review.json` by that extension's
 * `pi-review:sync`, in another repository, so nothing here notices the two
 * drifting apart. What makes the drift worth its own case is what it breaks:
 * `AGENTS.md` says the `review` check is *absent* rather than pending on a pull
 * request that changes only prose, and that is true only while the workflow's
 * `paths` still says what the settings say. A job that starts running where the
 * rule says it does not is a wait that never ends.
 */
describe("pi-review's generated workflow", () => {
	async function excludes(): Promise<{
		declared: string[];
		included: string[];
		settings: string[];
	}> {
		const workflow = await readWorkflow("pi-review.yml");
		const on = workflow.on as { pull_request?: { paths?: string[] } } | undefined;
		const patterns = on?.pull_request?.paths ?? [];
		const declared = patterns
			.filter((pattern) => pattern.startsWith("!"))
			.map((pattern) => pattern.slice(1));
		const included = patterns.filter((pattern) => !pattern.startsWith("!"));
		const settings = parse(await readFile(join(ROOT, ".github/pi-review.json"), "utf8")) as {
			paths?: { exclude?: string[] };
		};
		return { declared, included, settings: settings.paths?.exclude ?? [] };
	}

	/**
	 * Equality alone is not enough, and this is the case that shows it: if the
	 * renderer dropped every exclude, both sides would be `[]`, equality would
	 * hold, and this block would call the filter correct while every prose-only
	 * pull request went back to paying for a full review. So the two excludes that
	 * do the work are named, and the positive pattern the negations subtract from
	 * is required too, because GitHub rejects a filter that is all negations.
	 */
	test("the paths it skips are the ones the settings exclude", async () => {
		const { declared, included, settings } = await excludes();
		expect(
			included,
			"the negations have nothing to subtract from, and GitHub rejects a filter with no positive pattern",
		).toEqual(["**"]);
		expect(declared).toEqual(settings);
		expect(
			declared,
			"an exclude that saves a review has gone missing, so prose-only pull requests are reviewed again",
		).toEqual(expect.arrayContaining(["docs/research/**", "CHANGELOG.md"]));
	});

	/**
	 * The one case that watches the source rather than the generated copy. The bot
	 * guard reaches the workflow through `triggers.skipBots`, so reverting the
	 * setting alone leaves the checked-in workflow correct and every other case
	 * green: the guard holds until somebody regenerates, and then it is gone. Two
	 * assertions, because they fail for different reasons — the setting is the
	 * policy decision 151 made, and the agreement between the two is what catches
	 * the drift that a sync would make real.
	 */
	test("the settings still say a bot's pull request does not start it", async () => {
		const settings = parse(await readFile(join(ROOT, ".github/pi-review.json"), "utf8")) as {
			triggers?: { skipBots?: boolean };
		};
		expect(
			settings.triggers?.skipBots,
			"skipBots is off, so the next sync drops the guard and every Dependabot pull request fails both readers again",
		).toBe(true);

		const condition = collapse(
			Object.values((await readWorkflow("pi-review.yml")).jobs ?? {})
				.map((job) => job.if ?? "")
				.join(" "),
		);
		const carriesIt = condition.includes("github.event.pull_request.user.type != 'Bot'");
		expect(
			carriesIt,
			`the workflow and the settings disagree: skipBots is true and pi-review.yml does not carry the clause (run the sync)`,
		).toBe(true);
	});

	/**
	 * Skipping prose is a budget decision, and only prose nothing obeys qualifies.
	 * `docs/agents-guide.md` is the draft `AGENTS.md` came from and
	 * `docs/implementation/README.md` is what `AGENTS.md` tells a step builder to
	 * follow, so both are instruction files in all but name: `pi-review` reads its
	 * guidance from the base commit and `claude-review` reads the checkout, which
	 * is the head, so a pull request that rewrote one of them and started no shell
	 * reviewer would be asking only the reader that can be rewritten to read it.
	 * `docs/research/` is the one directory that says of itself that it is not
	 * settled fact, which is why it is the only prose that is skipped.
	 */
	test("it skips prose only, never a file an agent obeys", async () => {
		const { declared } = await excludes();
		const obeyed = declared.filter(
			(pattern) => pattern !== "CHANGELOG.md" && !pattern.startsWith("docs/research/"),
		);
		expect(
			obeyed,
			"an excluded path outside docs/research/ is code or an instruction file, and both need the reviewer with a shell",
		).toEqual([]);
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
