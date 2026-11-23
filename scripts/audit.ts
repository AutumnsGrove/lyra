#!/usr/bin/env node
/**
 * A dependency advisory scan, for `security.yml` (issue #39).
 *
 * **This is not part of the gate.** `pnpm audit` reads the registry, so the gate
 * would stop working offline, and a scan fails for a reason nobody in this diff
 * introduced. Nova's `make vuln` carries the same carve-out with the same reason.
 * The gate is about the code; this is about the world.
 *
 * What it buys, said plainly: this package has **no runtime dependencies**
 * (`scripts/importcheck`'s allow-list keeps it that way), so a consumer cannot
 * inherit a vulnerable module from Lyra. What is left is the toolchain that runs
 * in CI and on a maintainer's machine — wrangler, vite, vitest, the workers
 * plugin — which executes here with the gate's permissions.
 *
 * A scan that cannot reach the advisory database is a failure, not a clean
 * result. A green run that never looked is worse than a red one.
 *
 * Run: `pnpm run audit` (weekly and on pull requests, from the workflow).
 */
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ALLOW_FILE = resolve(ROOT, "scripts/security-allow.json");

const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

/**
 * Anything at or above this fails the run. `moderate` is the usual default and it
 * is too noisy to survive: a moderate advisory in a test-only dependency, with no
 * fix published, would leave the weekly run red for months and teach everyone to
 * ignore it. High and critical are worth a human.
 */
const FLOOR: Severity = "high";

export interface Advisory {
	id: string;
	severity: Severity;
	module: string;
	title: string;
	url: string;
}

export interface Verdict {
	ok: boolean;
	/** At or above the floor and not allowed: these decide the run. */
	failing: Advisory[];
	/** At or above the floor but named in the allow-list with a reason. */
	allowed: Advisory[];
	/** Below the floor. Reported, never fatal. */
	noticed: Advisory[];
	problems: string[];
}

export interface AllowEntry {
	id: string;
	reason: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function severityOf(value: unknown, where: string): Severity {
	const match = SEVERITIES.find((severity) => severity === value);
	if (match === undefined) {
		// Outside data is validated where it enters: an unrecognised severity may be
		// a new level, and guessing would either miss it or invent a failure.
		throw new Error(`${where}: unknown severity ${JSON.stringify(value)}`);
	}
	return match;
}

/**
 * Read `pnpm audit --json` and decide what it means.
 *
 * The advisory ids used for the allow-list are the `github_advisory_id` when one
 * exists, because that is the stable identifier across registries, and npm's
 * numeric id otherwise.
 */
export function judge(report: unknown, allowed: readonly AllowEntry[]): Verdict {
	if (!isRecord(report)) {
		throw new Error("audit report is not an object");
	}
	const advisories = report.advisories;
	if (!isRecord(advisories)) {
		throw new Error("audit report has no advisories object");
	}

	const verdict: Verdict = { ok: true, failing: [], allowed: [], noticed: [], problems: [] };
	const allowById = new Map<string, AllowEntry>();
	for (const entry of allowed) {
		if (entry.reason.trim() === "") {
			throw new Error(`allow-list entry ${entry.id} has no reason, so it is a silent allow`);
		}
		allowById.set(entry.id, entry);
	}

	for (const [key, raw] of Object.entries(advisories)) {
		if (!isRecord(raw)) {
			throw new Error(`advisory ${key} is not an object`);
		}
		const severity = severityOf(raw.severity, `advisory ${key}`);
		const githubId = typeof raw.github_advisory_id === "string" ? raw.github_advisory_id : "";
		const advisory: Advisory = {
			id: githubId === "" ? key : githubId,
			severity,
			module: typeof raw.module_name === "string" ? raw.module_name : "(unknown module)",
			title: typeof raw.title === "string" ? raw.title : "(no title)",
			url: typeof raw.url === "string" ? raw.url : "",
		};
		if (severityRank(severity) < severityRank(FLOOR)) {
			verdict.noticed.push(advisory);
			continue;
		}
		// Either id may be how a person wrote the allow-list down, so both are tried.
		const allowEntry = allowById.get(advisory.id) ?? allowById.get(key);
		if (allowEntry === undefined) {
			verdict.failing.push(advisory);
		} else {
			verdict.allowed.push(advisory);
		}
	}

	verdict.ok = verdict.failing.length === 0;
	return verdict;
}

function severityRank(severity: Severity): number {
	return SEVERITIES.indexOf(severity);
}

export async function readAllowList(path = ALLOW_FILE): Promise<AllowEntry[]> {
	const text = await readFile(path, "utf8");
	const parsed: unknown = JSON.parse(text);
	if (!isRecord(parsed) || !Array.isArray(parsed.allow)) {
		throw new Error(`${path} must be an object with an "allow" array`);
	}
	return parsed.allow.map((entry: unknown, index) => {
		if (!isRecord(entry) || typeof entry.id !== "string" || typeof entry.reason !== "string") {
			throw new Error(`${path}: allow[${index}] needs a string id and a string reason`);
		}
		return { id: entry.id, reason: entry.reason };
	});
}

export interface AuditRun {
	code: number;
	stdout: string;
	stderr: string;
}

/** Run `pnpm audit` in `cwd`. The seam the cases replace is `judge`, not this. */
export function runAudit(cwd: string): Promise<AuditRun> {
	return new Promise((settle, fail) => {
		const child = spawn("pnpm", ["audit", "--json"], { cwd });
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

/** Everything `pnpm run audit` does, in one call, so a workflow has one command. */
export async function audit(cwd = ROOT): Promise<{ code: number; output: string }> {
	const run = await runAudit(cwd);
	let parsed: unknown;
	try {
		parsed = JSON.parse(run.stdout);
	} catch {
		// The usual cause is no network, which prints nothing on stdout and explains
		// itself on stderr. A scan that errored must not read as a clean scan.
		return {
			code: 1,
			output: [
				"audit: could not read an audit report from pnpm",
				run.stderr.trim(),
				`audit: pnpm exited ${run.code}`,
			]
				.filter((line) => line !== "")
				.join("\n"),
		};
	}

	const verdict = judge(parsed, await readAllowList());
	const lines: string[] = [];
	for (const advisory of verdict.failing) {
		lines.push(
			`audit: ${advisory.severity.toUpperCase()} ${advisory.id} ${advisory.module}: ${advisory.title}`,
			advisory.url === "" ? "" : `  ${advisory.url}`,
		);
	}
	for (const advisory of verdict.allowed) {
		lines.push(
			`audit: allowed ${advisory.id} ${advisory.module} (${advisory.severity}), see scripts/security-allow.json`,
		);
	}
	for (const advisory of verdict.noticed) {
		lines.push(
			`audit: below the ${FLOOR} floor, not failing: ${advisory.id} ${advisory.module}`,
		);
	}
	lines.push(
		verdict.ok
			? `audit: clean above the ${FLOOR} floor`
			: `audit: ${verdict.failing.length} advisor${verdict.failing.length === 1 ? "y" : "ies"} at or above ${FLOOR}`,
	);
	return { code: verdict.ok ? 0 : 1, output: lines.filter((line) => line !== "").join("\n") };
}

const invokedDirectly =
	process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
	const result = await audit();
	console.log(result.output);
	process.exitCode = result.code;
}
