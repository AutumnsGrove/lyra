#!/usr/bin/env node
/**
 * The nightly run: the suite twice over, in a shuffled order (issue #40).
 *
 * The pull request gate runs the suite once, in whatever order the runner
 * produced. That cannot see a test that passes alone and fails beside another
 * one, or a run that inherits state from the run before it. Both matter here: the
 * workerd and socket suites run with isolation off (decision 101), so shared
 * state between files is the exact class of bug this can find.
 *
 * The honest caveat: this repository uses a fake clock and never sleeps on real
 * time, so there is little timing flakiness to find. The yield is state leakage.
 *
 * A failure has to be reproducible to be worth filing, so the seed is chosen here
 * and printed in the issue rather than left to the runner. A red run nobody can
 * reproduce is a red run nobody reads.
 *
 * Run: `pnpm run nightly` (the workflow does, on a schedule).
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** How many times each test runs. Two is enough to catch state left behind. */
const DEFAULT_REPEATS = 2;

/** A failing test, named the way the reporter names it. */
export interface Failure {
	file: string;
	test: string;
}

export interface Outcome {
	seed: string;
	repeats: number;
	passed: boolean;
	failures: Failure[];
	totalTests: number;
	/** Why the run could not be read, when the report was missing or damaged. */
	problem?: string;
}

export interface Report {
	seed: string;
	repeats: number;
	passed: boolean;
	title: string;
	body: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read Vitest's JSON report.
 *
 * Two things may be red. A failing assertion is the obvious one. The other is a
 * file that failed to collect, which has no failing assertion at all -- an import
 * that throws, a test that threw outside a case -- and reading only the
 * assertions would report that run as green. Nova's first scheduled run went
 * green with a red suite behind it for exactly this kind of reason, so a damaged
 * or missing report is a failure here rather than an empty list of failures.
 */
export function readReport(report: unknown, seed: string, repeats: number): Outcome {
	const outcome: Outcome = { seed, repeats, passed: false, failures: [], totalTests: 0 };
	if (!isRecord(report) || !Array.isArray(report.testResults)) {
		return { ...outcome, problem: "the run produced no readable report" };
	}
	outcome.totalTests = typeof report.numTotalTests === "number" ? report.numTotalTests : 0;
	for (const file of report.testResults) {
		if (!isRecord(file)) {
			continue;
		}
		const name = typeof file.name === "string" ? file.name : "(unknown file)";
		const assertions = Array.isArray(file.assertionResults) ? file.assertionResults : [];
		for (const assertion of assertions) {
			if (!isRecord(assertion) || assertion.status !== "failed") {
				continue;
			}
			const test =
				typeof assertion.fullName === "string"
					? assertion.fullName
					: typeof assertion.title === "string"
						? assertion.title
						: "(unknown test)";
			outcome.failures.push({ file: name, test });
		}
		// A file that failed with nothing failing inside it: a collection error, or a
		// teardown that threw. It still fails the run.
		if (
			file.status === "failed" &&
			assertions.every((a) => !isRecord(a) || a.status !== "failed")
		) {
			outcome.failures.push({ file: name, test: "(the file failed to run)" });
		}
	}
	outcome.passed = outcome.failures.length === 0;
	return outcome;
}

/**
 * The issue title is the identity the workflow dedupes on, so it carries the
 * failing tests and nothing random. Nova filed a new issue every night until it
 * moved the shuffle seed out of the title, and the seed is random per run by
 * design.
 */
export function issueTitle(outcome: Outcome): string {
	if (outcome.failures.length === 0) {
		// The run is red with nothing to name: the report was missing, or the suite
		// never started. That is one issue, however many times it happens.
		return "nightly: the shuffled run could not report a result";
	}
	const names = [...new Set(outcome.failures.map((failure) => shortName(failure.test)))].sort();
	const shown = names.slice(0, 3).join(", ");
	const more = names.length > 3 ? `, and ${names.length - 3} more` : "";
	return `nightly: ${shown}${more} failed under --shuffle`;
}

function shortName(fullName: string): string {
	const parts = fullName.split(" > ");
	return parts[parts.length - 1] ?? fullName;
}

export function issueBody(outcome: Outcome, runUrl?: string): string {
	const lines = [
		"The nightly `--sequence.shuffle --repeats=2` run on `main` failed.",
		"",
		`Seed: \`${outcome.seed}\` (random per run, so it is here rather than in the title)`,
		"",
		"Reproduce with:",
		"",
		"```",
		`pnpm exec vitest run --sequence.shuffle --sequence.seed=${outcome.seed} --repeats=${outcome.repeats}`,
		"```",
		"",
		`Tests run: ${outcome.totalTests}. Failures: ${outcome.failures.length}.`,
	];
	if (outcome.problem !== undefined) {
		lines.push("", `The report could not be read: ${outcome.problem}.`);
	}
	if (outcome.failures.length > 0) {
		lines.push("", "```");
		for (const failure of outcome.failures) {
			lines.push(`${failure.file}: ${failure.test}`);
		}
		lines.push("```");
	}
	if (runUrl !== undefined && runUrl !== "") {
		lines.push("", `Run: ${runUrl}`);
	}
	return `${lines.join("\n")}\n`;
}

/** A seed the issue can carry. Digits, because it is read aloud and retyped. */
export function chooseSeed(from?: string): string {
	const given = from ?? process.env["NIGHTLY_SEED"];
	if (given !== undefined && /^\d+$/.test(given)) {
		return given;
	}
	return String(Math.floor(Math.random() * 1_000_000));
}

/**
 * Every field is explicitly `| undefined` as well as optional, because the CLI
 * block below passes whatever flags it was given and `exactOptionalPropertyTypes`
 * treats "absent" and "present but undefined" as different.
 */
interface RunOptions {
	seed?: string | undefined;
	repeats?: number | undefined;
	/** Where to write the issue body, so the workflow can `gh issue create -F`. */
	bodyFile?: string | undefined;
	/** Where to write the title, which is the identity the workflow dedupes on. */
	titleFile?: string | undefined;
	runUrl?: string | undefined;
	/** Replace the runner, so the cases do not start a suite. */
	runSuite?: ((seed: string, repeats: number) => Promise<unknown>) | undefined;
}

/** Everything `pnpm run nightly` does, in one call, so the workflow has one command. */
export async function nightly(options: RunOptions = {}): Promise<Report> {
	const seed = chooseSeed(options.seed);
	const repeats = options.repeats ?? DEFAULT_REPEATS;
	const run = options.runSuite ?? runVitest;
	const report = await run(seed, repeats);
	const outcome = readReport(report, seed, repeats);
	const built: Report = {
		seed,
		repeats,
		passed: outcome.passed,
		// A green run files nothing, so it needs no title; the workflow only reads
		// this when there is a red to describe.
		title: outcome.passed ? "" : issueTitle(outcome),
		body: issueBody(outcome, options.runUrl),
	};
	if (options.bodyFile !== undefined) {
		await writeFile(options.bodyFile, built.body, "utf8");
	}
	if (options.titleFile !== undefined) {
		await writeFile(options.titleFile, `${built.title}\n`, "utf8");
	}
	return built;
}

/**
 * The suite, twice over, shuffled. The JSON reporter writes beside the temp
 * directory rather than into the tree, because a stray report file would be
 * committed by the next person to run `git add -A`.
 */
async function runVitest(seed: string, repeats: number): Promise<unknown> {
	const dir = await mkdtemp(join(tmpdir(), "nightly-"));
	const output = join(dir, "report.json");
	const code = await new Promise<number>((settle, fail) => {
		const child = spawn(
			"pnpm",
			[
				"exec",
				"vitest",
				"run",
				"--sequence.shuffle",
				`--sequence.seed=${seed}`,
				`--repeats=${repeats}`,
				"--reporter=json",
				`--outputFile=${output}`,
			],
			{ cwd: ROOT, stdio: "inherit" },
		);
		child.on("error", fail);
		child.on("close", (exit) => {
			settle(exit ?? 1);
		});
	});
	try {
		return JSON.parse(await readFile(output, "utf8"));
	} catch {
		// No report is a failure with a reason, not a crash: the caller reports it.
		return { code, testResults: undefined };
	}
}

/**
 * Read a flag in either spelling. `pnpm run nightly --repeats=1` reaches the
 * script as one argument, and a parser that only understood `--repeats 1` would
 * have silently ignored it (which it did, the first time this ran).
 */
export function argument(name: string, argv: readonly string[] = process.argv): string | undefined {
	const inline = argv.find((value) => value.startsWith(`${name}=`));
	if (inline !== undefined) {
		return inline.slice(name.length + 1);
	}
	const index = argv.indexOf(name);
	return index === -1 ? undefined : argv[index + 1];
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const report = await nightly({
		seed: argument("--seed"),
		repeats: argument("--repeats") === undefined ? undefined : Number(argument("--repeats")),
		bodyFile: argument("--body-file"),
		titleFile: argument("--title-file"),
		runUrl: process.env["NIGHTLY_RUN_URL"],
	});
	console.log(
		report.passed
			? `nightly: green with seed ${report.seed}`
			: `nightly: red with seed ${report.seed} — ${report.title}`,
	);
	process.exitCode = report.passed ? 0 : 1;
}
