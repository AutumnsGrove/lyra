#!/usr/bin/env node
/**
 * The import rules, enforced instead of trusted (docs/decisions.md, decisions 12, 13, 60, 69).
 *
 * 1. Every entry point may import only what its row allows. The core may not
 *    import an adapter or the testkit, so the loop cannot quietly gain a host.
 * 2. Nothing in `src/` may import `node:*` or any other Node builtin. The core
 *    runs on Cloudflare Workers and on Node from the same code, and a builtin is
 *    the one import that breaks that promise.
 * 3. This repository imports nothing from Lattice. Grove-specific pieces, the
 *    Lumen adapter included, live in Lattice and reach Lyra through a slot.
 * 4. A bare import must be a dependency the package declares, and every runtime
 *    dependency must be on the allow-list below, so a new one is a decision
 *    rather than a side effect.
 */
import { builtinModules } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_DIR = "packages/lyra";

/**
 * Entry points and what each one may import (decision 69). Add a row when an
 * adapter lands, with the smallest list it actually needs.
 */
const ENTRY_POINTS = [
	{
		name: "core",
		dir: "src",
		// Every other entry point is off limits from here. The core is the whole
		// contract; adapters depend on it, never the other way around.
		forbids: ["src/adapters", "src/testkit"],
	},
	{
		name: "memory",
		dir: "src/adapters/memory",
		// An adapter fills slots, so it needs the contract and nothing else. Its own
		// directory is always allowed.
		allows: ["src/core"],
	},
];

/**
 * Production code may not reach for the real clock, a real timer, real
 * randomness, or the console (docs/core-loop.md, "Time and identity are
 * injected"; docs/implementation/README.md, calls made in advance, 5). Console
 * is on the list because a log is the easiest way for a secret to leak.
 *
 * Comments count, on purpose: a mention is how the next reader learns the rule,
 * and a file that talks about `setTimeout` is a file about to call it.
 */
const BANNED_GLOBALS = [
	{ pattern: /\bDate\s*\.\s*now\b/g, name: "Date.now" },
	{ pattern: /\bnew\s+Date\s*\(/g, name: "new Date(" },
	{ pattern: /\bsetTimeout\b/g, name: "setTimeout" },
	{ pattern: /\bsetInterval\b/g, name: "setInterval" },
	{ pattern: /\bMath\s*\.\s*random\b/g, name: "Math.random" },
	{ pattern: /\bconsole\s*\./g, name: "console." },
];

/** The only file allowed to touch them, because it is the wrapper around them. */
const BANNED_GLOBALS_EXEMPT = new Set(["src/core/system-clock.ts"]);

/** Runtime dependencies this package may declare, one decision each. */
const RUNTIME_DEPENDENCY_ALLOW_LIST = [];

/** Packages from Lattice, and anything else that would make this repo depend on it. */
const LATTICE_PACKAGES = [
	"@autumnsgrove/engine",
	"@autumnsgrove/prism",
	"@autumnsgrove/infra",
	"@autumnsgrove/lumen",
	"@autumnsgrove/grove-agent",
	"grove-agent",
];

const NODE_BUILTINS = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

const problems = [];

function fail(file, line, message) {
	problems.push(`${relative(ROOT, file)}:${line}: ${message}`);
}

async function walk(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(path)));
		} else if (entry.name.endsWith(".ts")) {
			files.push(path);
		}
	}
	return files;
}

/** The 1-based line of a byte offset, for a message a person can act on. */
function lineAt(source, index) {
	return source.slice(0, index).split("\n").length;
}

function importsIn(source) {
	const specifiers = [];
	const patterns = [
		/\bfrom\s+["']([^"']+)["']/g,
		/\bimport\s+["']([^"']+)["']/g,
		/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
		/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
	];
	for (const pattern of patterns) {
		for (const match of source.matchAll(pattern)) {
			const index = match.index ?? 0;
			specifiers.push({ specifier: match[1], line: lineAt(source, index) });
		}
	}
	return specifiers;
}

/** Which entry point a source file belongs to, by the deepest listed directory. */
function entryPointFor(packageRelative) {
	const matches = ENTRY_POINTS.filter(
		(entry) =>
			packageRelative === entry.dir || packageRelative.startsWith(`${entry.dir}${sep}`),
	);
	return matches.at(-1);
}

/** A relative import as a package-relative path, even if it leaves the package. */
function resolveRelative(fromPackageRelative, specifier) {
	const target = resolve(join(PACKAGE_DIR, fromPackageRelative), "..", specifier);
	const packagePrefix = join(ROOT, PACKAGE_DIR);
	if (!target.startsWith(packagePrefix)) {
		return null;
	}
	return relative(packagePrefix, target);
}

async function checkSourceFiles() {
	const srcDir = join(ROOT, PACKAGE_DIR, "src");
	const files = await walk(srcDir);
	const packageJson = JSON.parse(await readFile(join(ROOT, PACKAGE_DIR, "package.json"), "utf8"));
	const rootJson = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
	const declared = new Set(Object.keys(packageJson.dependencies ?? {}));
	// A test may use the workspace's development tooling, such as the test
	// runner. Production code may not: everything it imports is a dependency a
	// consumer installs.
	const devOnly = new Set([
		...Object.keys(packageJson.devDependencies ?? {}),
		...Object.keys(rootJson.devDependencies ?? {}),
	]);
	const entryNames = new Set(ENTRY_POINTS.map((entry) => entry.name));

	for (const file of files) {
		const packageRelative = relative(join(ROOT, PACKAGE_DIR), file);
		const entry = entryPointFor(packageRelative);
		const isTest = /\.(test|fuzz\.test|testing)\.ts$/.test(file);
		const source = await readFile(file, "utf8");

		// A test may control time, because a test is where time is controlled. A
		// declaration file emits no code, so declaring `setTimeout` is not calling it,
		// and the one exemption in production code is the file that wraps the real ones.
		const portable = packageRelative.split(sep).join("/");
		if (!isTest && !file.endsWith(".d.ts") && !BANNED_GLOBALS_EXEMPT.has(portable)) {
			for (const banned of BANNED_GLOBALS) {
				for (const match of source.matchAll(banned.pattern)) {
					fail(
						file,
						lineAt(source, match.index ?? 0),
						`uses ${banned.name}: time, ids and logging are injected, so they belong in the caller or in core/system-clock.ts`,
					);
				}
			}
		}

		for (const { specifier, line } of importsIn(source)) {
			if (specifier.startsWith(".")) {
				const target = resolveRelative(packageRelative, specifier);
				if (target === null) {
					fail(file, line, `imports ${specifier}, which leaves ${PACKAGE_DIR}`);
					continue;
				}
				// A test may reach across entry points, because nothing here ships it:
				// a test in an adapter can use the testkit, and the core's tests can too.
				if (isTest) {
					continue;
				}
				// Imports are written with a `.js` extension (NodeNext), so the suffix is
				// checked in both forms rather than one.
				if (target.endsWith(".testing.ts") || target.endsWith(".testing.js")) {
					fail(file, line, `imports ${target}, which is test support, not a module`);
					continue;
				}
				if (entry === undefined) {
					continue;
				}
				for (const forbidden of entry.forbids ?? []) {
					if (target === forbidden || target.startsWith(`${forbidden}${sep}`)) {
						fail(
							file,
							line,
							`${entry.name} may not import ${forbidden} (${specifier})`,
						);
					}
				}
				if (entry.allows !== undefined) {
					const permitted = [entry.dir, ...entry.allows];
					const inside = permitted.some(
						(prefix) => target === prefix || target.startsWith(`${prefix}${sep}`),
					);
					if (!inside) {
						fail(file, line, `${entry.name} may not import ${target} (${specifier})`);
					}
				}
				continue;
			}

			if (NODE_BUILTINS.has(specifier)) {
				fail(file, line, `imports ${specifier}: the core is web-standard only`);
				continue;
			}

			if (
				LATTICE_PACKAGES.some(
					(name) => specifier === name || specifier.startsWith(`${name}/`),
				)
			) {
				fail(
					file,
					line,
					`imports ${specifier}: this repository imports nothing from Lattice`,
				);
				continue;
			}

			if (specifier === packageJson.name || specifier.startsWith(`${packageJson.name}/`)) {
				const subpath = specifier.slice(packageJson.name.length + 1) || "core";
				if (!entryNames.has(subpath)) {
					fail(file, line, `imports ${specifier}, which is not an entry point`);
				}
				if (entry?.name === "core" && subpath !== "core") {
					fail(file, line, `core may not import the ${subpath} entry point`);
				}
				continue;
			}

			const allowed = isTest
				? declared.has(specifier) || devOnly.has(specifier)
				: declared.has(specifier);
			if (!allowed && !RUNTIME_DEPENDENCY_ALLOW_LIST.includes(specifier)) {
				fail(
					file,
					line,
					`imports ${specifier}, which is not a declared dependency or on the allow-list`,
				);
			}
		}
	}

	for (const dependency of declared) {
		if (!RUNTIME_DEPENDENCY_ALLOW_LIST.includes(dependency)) {
			problems.push(
				`${PACKAGE_DIR}/package.json: dependency ${dependency} is not on the allow-list in scripts/importcheck.mjs`,
			);
		}
	}
}

await checkSourceFiles();

if (problems.length > 0) {
	console.error(`importcheck: ${problems.length} problem(s)\n`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	process.exit(1);
}

console.log(`importcheck: ok (${ENTRY_POINTS.length} entry point(s), core web-standard only)`);
