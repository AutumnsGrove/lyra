import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import {
	checkWorkflows,
	handWrittenWorkflows,
	type Lint,
	type LintResult,
} from "./workflowcheck.ts";

/**
 * The workflow lint (issue #38).
 *
 * No case here runs a real linter: `checkWorkflows` takes one as an argument, and
 * these pass a fake that records what it was asked to read. That keeps the suite
 * offline and deterministic, and it leaves one thing for the gate itself to do,
 * which is run the real binary against the real files.
 */

interface Recording {
	lint: Lint;
	files: string[][];
}

function recording(answer: LintResult | Error = { code: 0, stdout: "", stderr: "" }): Recording {
	const files: string[][] = [];
	const lint: Lint = async (given) => {
		files.push([...given]);
		if (answer instanceof Error) {
			throw answer;
		}
		return answer;
	};
	return { lint, files };
}

/** A directory holding the files named, for the cases about what gets picked. */
async function workflowsDir(names: readonly string[]): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "workflows-"));
	await mkdir(dir, { recursive: true });
	for (const name of names) {
		await writeFile(
			join(dir, name),
			"name: fixture\non:\n  push:\njobs:\n  a:\n    runs-on: x\n",
		);
	}
	return dir;
}

describe("what gets linted", () => {
	/**
	 * The generated workflow is excluded on purpose: `pi-review` writes it from
	 * `.github/pi-review.json`, so a finding in it is not ours to fix here. Its
	 * presence in this fixture is the point of the case.
	 */
	test("every hand-written workflow, and not the generated one", async () => {
		const dir = await workflowsDir(["ci.yml", "release.yml", "pi-review.yml", "notes.md"]);
		const { lint, files } = recording();
		const report = await checkWorkflows(lint, dir);
		expect(files).toHaveLength(1);
		expect(files[0]?.map((path) => path.split("/").pop())).toEqual(["ci.yml", "release.yml"]);
		expect(report.files).toEqual(files[0]);
	});

	/**
	 * A moved or renamed directory must not turn the check into a no-op that
	 * always passes, which is the same guard Nova puts on `own-workflows`.
	 */
	test("a directory with no workflows is an error, not a pass", async () => {
		const dir = await workflowsDir(["pi-review.yml", "README.md"]);
		const { lint } = recording();
		await expect(checkWorkflows(lint, dir)).rejects.toThrow(/no workflows to lint/);
		await expect(handWrittenWorkflows(dir)).rejects.toThrow(/no workflows to lint/);
	});
});

describe("the verdict", () => {
	test("a clean run passes, and says what it read", async () => {
		const { lint, files } = recording({ code: 0, stdout: "", stderr: "" });
		const report = await checkWorkflows(lint, await workflowsDir(["ci.yml"]));
		expect(report.code).toBe(0);
		expect(report.files).toHaveLength(1);
		expect(files).toHaveLength(1);
	});

	/**
	 * The linter's own words are the answer: a finding names the file and the line,
	 * and a verdict without them is a red check nobody can act on.
	 */
	test("a finding fails the run and keeps what the linter said", async () => {
		const message = 'ci.yml:12:9: unexpected key "brench" [syntax-check]';
		const { lint } = recording({ code: 1, stdout: "", stderr: message });
		const report = await checkWorkflows(lint, await workflowsDir(["ci.yml"]));
		expect(report.code).toBe(1);
		expect(report.output).toContain("unexpected key");
		expect(report.output).toContain("ci.yml:12:9");
	});

	test("a linter that cannot start fails the run rather than passing it", async () => {
		const { lint } = recording(new Error("spawn actionlint ENOENT"));
		const report = await checkWorkflows(lint, await workflowsDir(["ci.yml"]));
		expect(report.code).toBe(1);
		expect(report.output).toContain("could not run the linter");
		expect(report.output).toContain("ENOENT");
	});
});
