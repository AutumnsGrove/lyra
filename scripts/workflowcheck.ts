#!/usr/bin/env node
/**
 * Lint the workflows this repository maintains (issue #38).
 *
 * Five workflows run on every change and, until this existed, none of them had
 * ever been machine-checked: `release.yml` was linted by hand once, before it was
 * trusted, which is a memory rather than a mechanism. A workflow with a typo'd
 * input does not fail here; it fails when GitHub tries to load the file, which is
 * after the push.
 *
 * `pi-review.yml` is excluded on purpose: the review bot generates it from
 * `.github/pi-review.json`, so a finding in it is not ours to fix in this
 * repository (Nova makes the same carve-out in its `make actionlint`).
 *
 * The script takes a linter as an argument so its own cases can pass a fake one.
 * Nothing in the test suite runs a real linter, and nothing here touches the
 * network.
 *
 * Run: `pnpm run workflowcheck` (it is part of the gate).
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const WORKFLOWS = join(ROOT, ".github/workflows");

/** The generated workflow: `pi-review` writes it from `.github/pi-review.json`. */
const GENERATED = "pi-review.yml";

export interface LintResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** A linter takes the files to read and answers with what it found. */
export type Lint = (files: readonly string[]) => Promise<LintResult>;

export interface Report {
	code: number;
	output: string;
	files: string[];
}

/**
 * The workflows this repository maintains, as paths relative to the repository.
 *
 * An empty list is an error rather than a pass, because a moved or renamed
 * directory must not turn this check into a no-op that always succeeds.
 */
export async function handWrittenWorkflows(dir = WORKFLOWS): Promise<string[]> {
	const entries = await readdir(dir);
	const files = entries.filter((name) => name.endsWith(".yml") && name !== GENERATED).sort();
	if (files.length === 0) {
		throw new Error(`no workflows to lint in ${dir}`);
	}
	return files.map((name) => join(".github/workflows", name));
}

export async function checkWorkflows(lint: Lint, dir = WORKFLOWS): Promise<Report> {
	const files = await handWrittenWorkflows(dir);
	let result: LintResult;
	try {
		result = await lint(files);
	} catch (cause) {
		// A linter that cannot start must not read as a clean tree. `pnpm run
		// workflowcheck` exits non-zero on a failure, so a missing binary is loud.
		const reason = cause instanceof Error ? cause.message : String(cause);
		return { code: 1, output: `workflowcheck: could not run the linter: ${reason}`, files };
	}
	const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join("\n");
	return { code: result.code, output, files };
}

/**
 * The real linter, as `pnpm run workflowcheck` resolves it from the devDependency.
 *
 * `-shellcheck=` and `-pyflakes=` are emptied on purpose. Both integrations look
 * for a program on `PATH`, and shellcheck is installed on a GitHub runner and
 * often not on a laptop, so leaving them on would make the gate's verdict depend
 * on the machine that ran it. What is left is the check of the workflow files
 * themselves, which is the same everywhere.
 */
export function actionlint(files: readonly string[]): Promise<LintResult> {
	return new Promise((settle, fail) => {
		const child = spawn("actionlint", ["-shellcheck=", "-pyflakes=", ...files], {
			cwd: ROOT,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", fail);
		child.on("close", (code) => {
			settle({ code: code ?? 1, stdout, stderr });
		});
	});
}

/**
 * `import.meta.main` would say this, but `.nvmrc` pins Node 22, where it does not
 * exist yet. Comparing the resolved entry point works on every Node this
 * repository supports, and it is false when the cases import this file.
 */
const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const report = await checkWorkflows(actionlint);
	if (report.output !== "") {
		console.error(report.output);
	}
	if (report.code !== 0) {
		console.error(
			`workflowcheck: ${report.files.length} workflow(s) linted, at least one failed`,
		);
	} else {
		console.log(`workflowcheck: ${report.files.length} workflow(s) clean`);
	}
	process.exitCode = report.code;
}
