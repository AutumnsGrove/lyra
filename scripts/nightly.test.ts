import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	argument,
	chooseSeed,
	issueBody,
	issueTitle,
	nightly,
	readReport,
	type ConfigRun,
} from "./nightly.ts";

/**
 * The nightly run (issue #40).
 *
 * The cases pass reports in rather than running the suite: the subject is what a
 * run means, not whether the suite is green today. The workflow runs the real
 * thing on a schedule.
 */

function report(files: readonly Record<string, unknown>[], totalTests = 3): unknown {
	return {
		numTotalTests: totalTests,
		success: files.every((file) => file.status !== "failed"),
		testResults: files,
	};
}

function file(
	name: string,
	status: string,
	assertions: readonly Record<string, unknown>[],
): Record<string, unknown> {
	return { name, status, assertionResults: assertions };
}

function assertion(fullName: string, status: string): Record<string, unknown> {
	return { fullName, title: fullName.split(" > ").pop(), status, failureMessages: [] };
}

/** One suite's run: what the reporter wrote, and what the child exited with. */
function run(reportOf: unknown, exitCode: number | null = 0, config = "node"): ConfigRun {
	return { config, exitCode, report: reportOf };
}

describe("reading the report", () => {
	test("a green run passes and counts its tests", () => {
		const outcome = readReport(
			[
				run(
					report([
						file("a.test.ts", "passed", [assertion("suite > a", "passed")]),
						file("b.test.ts", "passed", [assertion("suite > b", "passed")]),
					]),
				),
			],
			"1234",
			2,
		);
		expect(outcome.passed).toBe(true);
		expect(outcome.failures).toEqual([]);
		expect(outcome.problems).toEqual([]);
		expect(outcome.totalTests).toBe(3);
		expect(outcome.seed).toBe("1234");
		expect(outcome.repeats).toBe(2);
	});

	test("a failed assertion is named by file and full test name", () => {
		const outcome = readReport(
			[
				run(
					report([
						file("a.test.ts", "failed", [
							assertion("reader > FRM03 splits lines", "failed"),
							assertion("reader > ok", "passed"),
						]),
					]),
				),
			],
			"9",
			2,
		);
		expect(outcome.passed).toBe(false);
		expect(outcome.failures).toEqual([
			{ file: "a.test.ts", test: "reader > FRM03 splits lines" },
		]);
	});

	/**
	 * An import that throws, or a hook that fails outside a case, leaves a failed
	 * file with no failed assertion. Reading only the assertions would call that
	 * run green, which is the failure mode Nova's first scheduled run had.
	 */
	test("a file that failed with nothing failing inside it still fails the run", () => {
		const outcome = readReport([run(report([file("broken.test.ts", "failed", [])]))], "7", 2);
		expect(outcome.passed).toBe(false);
		expect(outcome.failures).toEqual([
			{ file: "broken.test.ts", test: "(the file failed to run)" },
		]);
	});

	/**
	 * The case review found: a Vitest invocation that matched no test exits 1 and
	 * writes `{"success":false,"testResults":[]}`. There is no failed assertion to
	 * read, so only the flag and the exit status say the run was red.
	 */
	test("a run that exited non-zero with no named failure is red, not green", () => {
		const outcome = readReport(
			[run({ success: false, numTotalTests: 0, testResults: [] }, 1)],
			"5",
			2,
		);
		expect(outcome.passed).toBe(false);
		expect(outcome.failures).toEqual([]);
		expect(outcome.problems.join(" ")).toMatch(/node: vitest exited 1/);
		expect(outcome.problems.join(" ")).toMatch(/named no test/);
	});

	/** A report that claims success while the child died is still a red run. */
	test("a non-zero exit with a green report is red", () => {
		const outcome = readReport(
			[run(report([file("a.test.ts", "passed", [assertion("s > a", "passed")])]), 137)],
			"5",
			2,
		);
		expect(outcome.passed).toBe(false);
		expect(outcome.problems.join(" ")).toMatch(/vitest exited 137/);
	});

	test("a report that says it failed and names no test is a problem", () => {
		const outcome = readReport([run({ success: false, testResults: [] })], "5", 2);
		expect(outcome.passed).toBe(false);
		expect(outcome.problems.join(" ")).toMatch(/named no test/);
	});

	test("a report that cannot be read is a failure with a reason", () => {
		expect(readReport([run({})], "1", 2).problems.join(" ")).toMatch(/no readable report/);
		expect(readReport([run(null)], "1", 2).passed).toBe(false);
		expect(readReport([], "1", 2).problems.join(" ")).toMatch(/no suite was run/);
	});
});

describe("all three suites", () => {
	/**
	 * The workerd and socket suites are the reason the shuffled run matters (they
	 * run with isolation off, decision 101), so a red in either one has to reach the
	 * issue. The Node suite being green must not hide it.
	 */
	test("a failure in one suite is reported even when the others are green", () => {
		const outcome = readReport(
			[
				run(
					report([file("node.test.ts", "passed", [assertion("s > n", "passed")])]),
					0,
					"node",
				),
				run(
					report([
						file("workerd.workers.test.ts", "failed", [assertion("s > w", "failed")]),
					]),
					0,
					"workerd",
				),
				run(
					report([file("socket.test.ts", "passed", [assertion("s > s", "passed")])]),
					0,
					"socket",
				),
			],
			"3",
			2,
		);
		expect(outcome.passed).toBe(false);
		expect(outcome.failures).toEqual([{ file: "workerd.workers.test.ts", test: "s > w" }]);
	});

	test("one suite failing to start does not hide another suite's failure", () => {
		const outcome = readReport(
			[
				run(undefined, 1, "node"),
				run(
					report([file("a.test.ts", "failed", [assertion("s > a", "failed")])]),
					0,
					"socket",
				),
			],
			"3",
			2,
		);
		expect(outcome.failures).toHaveLength(1);
		expect(outcome.problems.join(" ")).toMatch(/node: the run produced no readable report/);
	});

	test("the totals are summed across suites", () => {
		const outcome = readReport(
			[
				run(report([], 4), 0, "node"),
				run(report([], 5), 0, "workerd"),
				run(report([], 6), 0, "socket"),
			],
			"3",
			2,
		);
		expect(outcome.totalTests).toBe(15);
		expect(outcome.passed).toBe(true);
	});
});

describe("the issue title", () => {
	/**
	 * The title is what the workflow dedupes on, so it may not contain anything
	 * random. The seed is random every night by design, and putting it here filed a
	 * new issue per night in Nova.
	 */
	test("is the same for the same failures in any order, and for repeats", () => {
		const forward = readReport(
			[
				run(
					report([
						file("a.test.ts", "failed", [
							assertion("s > one", "failed"),
							assertion("s > two", "failed"),
						]),
					]),
				),
			],
			"111",
			2,
		);
		const backward = readReport(
			[
				run(
					report([
						file("a.test.ts", "failed", [
							assertion("s > two", "failed"),
							assertion("s > one", "failed"),
						]),
					]),
				),
			],
			"999",
			2,
		);
		expect(issueTitle(forward)).toBe(issueTitle(backward));
		expect(issueTitle(forward)).toContain("one");
		expect(issueTitle(forward)).toContain("two");
	});

	test("names at most three, and counts the rest", () => {
		const outcome = readReport(
			[
				run(
					report([
						file("a.test.ts", "failed", [
							assertion("s > one", "failed"),
							assertion("s > two", "failed"),
							assertion("s > three", "failed"),
							assertion("s > four", "failed"),
						]),
					]),
				),
			],
			"5",
			2,
		);
		expect(issueTitle(outcome)).toContain("and 1 more");
	});

	test("different failures are different titles", () => {
		const one = readReport(
			[run(report([file("a.test.ts", "failed", [assertion("s > one", "failed")])]))],
			"5",
			2,
		);
		const two = readReport(
			[run(report([file("a.test.ts", "failed", [assertion("s > other", "failed")])]))],
			"5",
			2,
		);
		expect(issueTitle(one)).not.toBe(issueTitle(two));
	});

	/**
	 * Two files that never ran are two different failures, not one. They share the
	 * sentinel for "no test", so the title has to fall back to the file name or the
	 * second night becomes a comment on the first issue (found in review).
	 */
	test("two files that never ran are two titles", () => {
		const one = readReport([run(report([file("a.test.ts", "failed", [])]))], "5", 2);
		const two = readReport([run(report([file("b.test.ts", "failed", [])]))], "5", 2);
		expect(issueTitle(one)).toContain("a.test.ts");
		expect(issueTitle(two)).toContain("b.test.ts");
		expect(issueTitle(one)).not.toBe(issueTitle(two));
	});

	/** A red run with nothing to name is still one issue, not a new one per night. */
	test("a run that could not report has one title, whatever the seed", () => {
		const first = readReport([run(null)], "1", 2);
		const second = readReport([run(null)], "2", 2);
		expect(issueTitle(first)).toBe(issueTitle(second));
		expect(issueTitle(first)).toContain("could not report");
	});
});

describe("the issue body", () => {
	test("carries the seed and a command that reproduces each suite", () => {
		const outcome = readReport(
			[run(report([file("a.test.ts", "failed", [assertion("s > one", "failed")])]))],
			"424242",
			2,
		);
		const body = issueBody(outcome);
		expect(body).toContain("--sequence.seed=424242");
		expect(body).toContain("--repeats=2");
		expect(body).toContain("--config vitest.workers.config.ts");
		expect(body).toContain("--config vitest.ws.config.ts");
		expect(body).toContain("a.test.ts: s > one");
		expect(body).toContain("Failures: 1");
	});

	test("names the run when it is given one", () => {
		const outcome = readReport([run(report([]))], "1", 2);
		expect(issueBody(outcome, "https://example.test/run/1")).toContain(
			"https://example.test/run/1",
		);
	});

	test("lists what the run itself reported, and says when the report was unreadable", () => {
		const body = issueBody(readReport([run(undefined, 1, "workerd")], "1", 2));
		expect(body).toContain("workerd: the run produced no readable report");
		expect(body).toContain("workerd: vitest exited 1");
	});
});

describe("the seed", () => {
	test("an explicit seed wins, then the environment, then a random one", () => {
		expect(chooseSeed("123")).toBe("123");
		process.env["NIGHTLY_SEED"] = "456";
		try {
			expect(chooseSeed()).toBe("456");
			expect(chooseSeed("789")).toBe("789");
		} finally {
			delete process.env["NIGHTLY_SEED"];
		}
		expect(chooseSeed()).toMatch(/^\d+$/);
	});

	test("a seed that is not digits is ignored rather than passed to the suite", () => {
		expect(chooseSeed("--sequence.shuffle")).toMatch(/^\d+$/);
	});
});

describe("arguments", () => {
	/** `pnpm run nightly --repeats=1` arrives as one argument, and it did silently nothing. */
	test("both spellings of a flag are read", () => {
		expect(argument("--seed", ["--seed", "12"])).toBe("12");
		expect(argument("--seed", ["--seed=12"])).toBe("12");
		expect(argument("--seed", [])).toBeUndefined();
		// A flag whose name only starts with this one is not this one. This is the
		// assertion that fails if inline detection is ever loosened from
		// `startsWith(`${name}=`)` to `startsWith(name)`.
		expect(argument("--seed", ["--seeds=1"])).toBeUndefined();
		expect(argument("--seed", ["--seed="])).toBe("");
	});
});

describe("the run", () => {
	test("passes the seed through, writes the body and title, and reports the verdict", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nightly-test-"));
		const bodyFile = join(dir, "body.md");
		const titleFile = join(dir, "title.txt");
		const asked: string[] = [];
		const result = await nightly({
			seed: "31337",
			bodyFile,
			titleFile,
			runSuite: async (seed) => {
				asked.push(seed);
				return [
					run(report([file("a.test.ts", "failed", [assertion("s > one", "failed")])])),
				];
			},
		});
		expect(asked).toEqual(["31337"]);
		expect(result.passed).toBe(false);
		expect(result.seed).toBe("31337");
		expect(await readFile(bodyFile, "utf8")).toBe(result.body);
		expect(await readFile(titleFile, "utf8")).toBe(`${result.title}\n`);
		expect(result.body).toContain("--sequence.seed=31337");
	});

	test("a green run exits clean and writes no title", async () => {
		const result = await nightly({
			seed: "1",
			runSuite: async () => [
				run(report([file("a.test.ts", "passed", [assertion("s > a", "passed")])])),
			],
		});
		expect(result.passed).toBe(true);
		// Nothing to file, so nothing to title.
		expect(result.title).toBe("");
	});

	/**
	 * A runner that cannot start still files something. Throwing would leave no body
	 * and no title, and the workflow's filing step would stop before it filed
	 * (found in review).
	 */
	test("a runner that cannot start is red with a body, not a throw", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nightly-test-"));
		const bodyFile = join(dir, "body.md");
		const titleFile = join(dir, "title.txt");
		const result = await nightly({
			seed: "1",
			bodyFile,
			titleFile,
			runSuite: async () => {
				throw new Error("spawn pnpm ENOENT");
			},
		});
		expect(result.passed).toBe(false);
		expect(result.title).toContain("could not report a result");
		expect(result.body).toContain("spawn pnpm ENOENT");
		expect(await readFile(bodyFile, "utf8")).toContain("could not start");
		expect(await readFile(titleFile, "utf8")).toContain("could not report a result");
	});

	/** The seam end to end: a suite that died is red even with nothing named. */
	test("a suite that died is red through the whole path", async () => {
		const result = await nightly({
			seed: "1",
			runSuite: async () => [run({ success: false, testResults: [] }, 1)],
		});
		expect(result.passed).toBe(false);
		expect(result.body).toContain("vitest exited 1");
	});
});
