import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { argument, chooseSeed, issueBody, issueTitle, nightly, readReport } from "./nightly.ts";

/**
 * The nightly run (issue #40).
 *
 * The cases pass a report in rather than running the suite: the subject is what
 * the run means, not whether the suite is green today. The workflow runs the real
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

describe("reading the report", () => {
	test("a green run passes and counts its tests", () => {
		const outcome = readReport(
			report([
				file("a.test.ts", "passed", [assertion("suite > a", "passed")]),
				file("b.test.ts", "passed", [assertion("suite > b", "passed")]),
			]),
			"1234",
			2,
		);
		expect(outcome.passed).toBe(true);
		expect(outcome.failures).toEqual([]);
		expect(outcome.totalTests).toBe(3);
		expect(outcome.seed).toBe("1234");
		expect(outcome.repeats).toBe(2);
	});

	test("a failed assertion is named by file and full test name", () => {
		const outcome = readReport(
			report([
				file("a.test.ts", "failed", [
					assertion("reader > FRM03 splits lines", "failed"),
					assertion("reader > ok", "passed"),
				]),
			]),
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
		const outcome = readReport(report([file("broken.test.ts", "failed", [])]), "7", 2);
		expect(outcome.passed).toBe(false);
		expect(outcome.failures).toEqual([
			{ file: "broken.test.ts", test: "(the file failed to run)" },
		]);
	});

	test("a report that cannot be read is a failure with a reason", () => {
		expect(readReport({}, "1", 2).problem).toMatch(/no readable report/);
		expect(readReport(null, "1", 2).passed).toBe(false);
		expect(readReport(null, "1", 2).problem).toMatch(/no readable report/);
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
			report([
				file("a.test.ts", "failed", [
					assertion("s > one", "failed"),
					assertion("s > two", "failed"),
				]),
			]),
			"111",
			2,
		);
		const backward = readReport(
			report([
				file("a.test.ts", "failed", [
					assertion("s > two", "failed"),
					assertion("s > one", "failed"),
				]),
			]),
			"999",
			2,
		);
		expect(issueTitle(forward)).toBe(issueTitle(backward));
		expect(issueTitle(forward)).toContain("one");
		expect(issueTitle(forward)).toContain("two");
	});

	test("names at most three, and counts the rest", () => {
		const outcome = readReport(
			report([
				file("a.test.ts", "failed", [
					assertion("s > one", "failed"),
					assertion("s > two", "failed"),
					assertion("s > three", "failed"),
					assertion("s > four", "failed"),
				]),
			]),
			"5",
			2,
		);
		expect(issueTitle(outcome)).toContain("and 1 more");
	});

	test("different failures are different titles", () => {
		const one = readReport(
			report([file("a.test.ts", "failed", [assertion("s > one", "failed")])]),
			"5",
			2,
		);
		const two = readReport(
			report([file("a.test.ts", "failed", [assertion("s > other", "failed")])]),
			"5",
			2,
		);
		expect(issueTitle(one)).not.toBe(issueTitle(two));
	});

	/** A red run with nothing to name is still one issue, not a new one per night. */
	test("a run that could not report has one title, whatever the seed", () => {
		const first = readReport(null, "1", 2);
		const second = readReport(null, "2", 2);
		expect(issueTitle(first)).toBe(issueTitle(second));
		expect(issueTitle(first)).toContain("could not report");
	});
});

describe("the issue body", () => {
	test("carries the seed and a command that reproduces the run", () => {
		const outcome = readReport(
			report([file("a.test.ts", "failed", [assertion("s > one", "failed")])]),
			"424242",
			2,
		);
		const body = issueBody(outcome);
		expect(body).toContain("--sequence.seed=424242");
		expect(body).toContain("--repeats=2");
		expect(body).toContain("a.test.ts: s > one");
		expect(body).toContain("Failures: 1");
	});

	test("names the run when it is given one", () => {
		const outcome = readReport(report([]), "1", 2);
		expect(issueBody(outcome, "https://example.test/run/1")).toContain(
			"https://example.test/run/1",
		);
	});

	test("says when the report could not be read", () => {
		expect(issueBody(readReport(null, "1", 2))).toContain("could not be read");
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
		expect(argument("--seed", ["--seeds=1"])).toBeUndefined();
	});
});

describe("the run", () => {
	test("passes the seed through, writes the body, and reports the verdict", async () => {
		const dir = await mkdtemp(join(tmpdir(), "nightly-test-"));
		const bodyFile = join(dir, "body.md");
		const asked: string[] = [];
		const result = await nightly({
			seed: "31337",
			bodyFile,
			runSuite: async (seed) => {
				asked.push(seed);
				return report([file("a.test.ts", "failed", [assertion("s > one", "failed")])]);
			},
		});
		expect(asked).toEqual(["31337"]);
		expect(result.passed).toBe(false);
		expect(result.seed).toBe("31337");
		expect(await readFile(bodyFile, "utf8")).toBe(result.body);
		expect(result.body).toContain("--sequence.seed=31337");
	});

	test("a green run exits clean and names no failure", async () => {
		const result = await nightly({
			seed: "1",
			runSuite: async () =>
				report([file("a.test.ts", "passed", [assertion("s > a", "passed")])]),
		});
		expect(result.passed).toBe(true);
		// Nothing to file, so nothing to title.
		expect(result.title).toBe("");
	});
});
