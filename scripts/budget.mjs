#!/usr/bin/env node
/**
 * Size budgets, because a bundle that grows quietly is a design change nobody
 * decided (AGENTS.md, "Hard rules"; docs/engineering-practices.md).
 *
 * Measures the gzipped JavaScript each package ships, which is what a consumer
 * downloads, against the ceiling in scripts/budgets.json. Run `pnpm build`
 * first; `pnpm ci` does.
 */
import { gzipSync } from "node:zlib";
import { readFile, readdir, stat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES_DIR = join(ROOT, "packages");
const budgets = JSON.parse(await readFile(join(ROOT, "scripts/budgets.json"), "utf8"));

async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(path)));
		} else if (entry.name.endsWith(".js")) {
			files.push(path);
		}
	}
	return files;
}

async function exists(path) {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/** Package name to its directory, so a budget is keyed by what npm publishes. */
async function packageDirs() {
	const dirs = new Map();
	for (const entry of await readdir(PACKAGES_DIR, { withFileTypes: true })) {
		if (!entry.isDirectory()) {
			continue;
		}
		const dir = join(PACKAGES_DIR, entry.name);
		const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
		dirs.set(manifest.name, dir);
	}
	return dirs;
}

const dirs = await packageDirs();
const problems = [];
const summaries = [];

for (const [name, budget] of Object.entries(budgets)) {
	if (name.startsWith("_")) {
		continue;
	}
	const packageDir = dirs.get(name);
	if (packageDir === undefined) {
		problems.push(`${name} has a budget but no package under packages/`);
		continue;
	}
	const dist = join(packageDir, "dist");
	if (!(await exists(dist))) {
		console.error(`budget: ${relative(ROOT, dist)} is missing. Run \`pnpm build\` first.`);
		process.exit(1);
	}
	const files = await walk(dist);
	const sizes = await Promise.all(
		files.map(async (file) => gzipSync(await readFile(file)).byteLength),
	);
	const bytes = sizes.reduce((total, size) => total + size, 0);

	summaries.push(`${name}: ${files.length} file(s), ${bytes} B gzipped of ${budget.gzipBytes} B`);
	if (bytes > budget.gzipBytes) {
		const over = bytes - budget.gzipBytes;
		problems.push(`${name} is ${over} B over its ${budget.gzipBytes} B gzipped budget`);
	}
}

for (const summary of summaries) {
	console.log(`budget: ${summary}`);
}

if (problems.length > 0) {
	console.error(`\nbudget: ${problems.length} problem(s)`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	console.error("Split the module or cut scope before raising a budget.");
	process.exit(1);
}

console.log("budget: ok");
