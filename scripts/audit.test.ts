import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import { judge, readAllowList, verdict, type AllowEntry } from "./audit.ts";

/**
 * The advisory scan's judgment (issue #39).
 *
 * The report shape is npm's `audit --json`, trimmed to the fields read here. No
 * case runs `pnpm audit`: the network is the one thing the suite may not touch,
 * so the parsing and the verdict are tested and the workflow runs the real scan.
 */

function report(advisories: Record<string, unknown>): unknown {
	return {
		actions: [],
		advisories,
		metadata: { vulnerabilities: {}, dependencies: 1 },
	};
}

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		severity: "high",
		module_name: "adm-zip",
		title: "Decompression-bomb protection can be bypassed",
		url: "https://github.com/advisories/GHSA-rcw4-f5rp-g42v",
		github_advisory_id: "GHSA-rcw4-f5rp-g42v",
		...overrides,
	};
}

const noAllow: AllowEntry[] = [];

describe("what fails the run", () => {
	test("a high advisory fails it, and says what and which module", () => {
		const verdict = judge(report({ 1: advisory() }), noAllow);
		expect(verdict.ok).toBe(false);
		expect(verdict.failing).toHaveLength(1);
		expect(verdict.failing[0]?.module).toBe("adm-zip");
		expect(verdict.failing[0]?.title).toContain("Decompression-bomb");
		expect(verdict.failing[0]?.id).toBe("GHSA-rcw4-f5rp-g42v");
	});

	test("a critical advisory fails it too", () => {
		const verdict = judge(report({ 1: advisory({ severity: "critical" }) }), noAllow);
		expect(verdict.ok).toBe(false);
	});

	/**
	 * A moderate with no fix published would leave the weekly run red for months,
	 * and a check nobody can make green is a check people stop reading.
	 */
	test("a moderate or a low is noticed, not fatal", () => {
		const verdict = judge(
			report({
				1: advisory({ severity: "moderate" }),
				2: advisory({ severity: "low", github_advisory_id: "GHSA-other" }),
			}),
			noAllow,
		);
		expect(verdict.ok).toBe(true);
		expect(verdict.noticed).toHaveLength(2);
		expect(verdict.failing).toEqual([]);
	});

	test("the same advisory twice is two findings, and either can fail it", () => {
		const verdict = judge(
			report({
				1: advisory({ github_advisory_id: "GHSA-a" }),
				2: advisory({ severity: "low" }),
			}),
			noAllow,
		);
		expect(verdict.failing).toHaveLength(1);
		expect(verdict.noticed).toHaveLength(1);
		expect(verdict.ok).toBe(false);
	});
});

describe("the allow-list", () => {
	test("an allowed advisory is reported and does not fail the run", () => {
		const allow: AllowEntry[] = [
			{ id: "GHSA-rcw4-f5rp-g42v", reason: "no fix; the vulnerable path is not reachable" },
		];
		const verdict = judge(report({ 1: advisory() }), allow);
		expect(verdict.ok).toBe(true);
		expect(verdict.allowed.map((entry) => entry.id)).toEqual(["GHSA-rcw4-f5rp-g42v"]);
	});

	/** npm's numeric key is what a person sees first, so it may be what they write. */
	test("the numeric key allows it as well as the advisory id", () => {
		const verdict = judge(report({ 42: advisory() }), [
			{ id: "42", reason: "no fix published" },
		]);
		expect(verdict.ok).toBe(true);
	});

	/**
	 * An entry with no reason is a silent allow, which is the thing the file exists
	 * to prevent. It is an error rather than a warning, because warnings go unread.
	 */
	test("an entry with no reason is refused", () => {
		expect(() =>
			judge(report({ 1: advisory() }), [{ id: "GHSA-rcw4-f5rp-g42v", reason: "  " }]),
		).toThrow(/no reason/);
	});
});

describe("a report it cannot read", () => {
	/**
	 * Outside data is validated where it enters. A new severity level must not be
	 * guessed at, because either guess (fail or pass) is wrong in a way nobody sees.
	 */
	test("an unknown severity is an error, not a pass", () => {
		expect(() => judge(report({ 1: advisory({ severity: "catastrophic" }) }), noAllow)).toThrow(
			/unknown severity/,
		);
	});

	test("a report with no advisories object is an error", () => {
		expect(() => judge({ actions: [] }, noAllow)).toThrow(/no advisories object/);
		expect(() => judge(null, noAllow)).toThrow(/not an object/);
	});

	test("the allow-list file is read and validated", async () => {
		const dir = await mkdtemp(join(tmpdir(), "allow-"));
		const good = join(dir, "good.json");
		await writeFile(good, JSON.stringify({ allow: [{ id: "GHSA-x", reason: "why" }] }));
		expect(await readAllowList(good)).toEqual([{ id: "GHSA-x", reason: "why" }]);

		const bad = join(dir, "bad.json");
		await writeFile(bad, JSON.stringify({ allow: [{ id: "GHSA-x" }] }));
		await expect(readAllowList(bad)).rejects.toThrow(/needs a string id and a string reason/);

		const shaped = join(dir, "shaped.json");
		await writeFile(shaped, JSON.stringify({ nope: true }));
		await expect(readAllowList(shaped)).rejects.toThrow(/"allow" array/);
	});
});

describe("a report that is not a report", () => {
	/**
	 * The registry answers with an error object when it cannot be reached, and that
	 * parses as JSON. Review found this one: `judge` threw, `audit` rejected through
	 * the top-level await, and the job went red with a stack trace instead of the
	 * "could not reach the registry" sentence the file promises.
	 */
	test("an error-shaped report is a red verdict with a reason, not a throw", () => {
		const result = verdict(JSON.stringify({ error: { code: "ENOTFOUND" } }), noAllow);
		expect(result.code).toBe(1);
		expect(result.output).toContain("could not be read");
		expect(result.output).toContain("advisories object");
	});

	test("text that is not JSON is a red verdict with a reason", () => {
		const result = verdict("pnpm: no such command", noAllow);
		expect(result.code).toBe(1);
		expect(result.output).toContain("could not read an audit report");
	});

	test("an empty report is red rather than clean", () => {
		expect(verdict("", noAllow).code).toBe(1);
	});

	test("a clean report is green, and a high one is red", () => {
		expect(verdict(JSON.stringify(report({})), noAllow).code).toBe(0);
		const failing = verdict(JSON.stringify(report({ 1: advisory() })), noAllow);
		expect(failing.code).toBe(1);
		expect(failing.output).toContain("adm-zip");
	});
});
