import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

/**
 * The host-app pass in `scripts/importcheck.mjs` (decision 156). It is the only thing
 * that enforces "no Node builtin, nothing from Lattice, no undeclared import" on
 * `packages/playground/src`, and a check that runs on nothing passes silently, so the
 * rules get a fixture tree of their own:
 *
 * - a violation is reported with the file and the import;
 * - a fixture whose `src/` holds nothing is a problem, not a pass;
 * - a clean fixture passes, which is what makes the two above mean something.
 *
 * The script reads `LYRA_CHECK_ROOT` so this can run it against a temporary tree rather
 * than the real one; a test that renamed the real directory would race every other test.
 */

const run = promisify(execFile);
const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), "importcheck.mjs");

interface Tree {
	root: string;
	playground?: { manifest?: unknown; files?: Record<string, string> } | "no-src";
}

/** The smallest tree the two checks can run against: the package, and one host app. */
async function fixture(tree: Tree): Promise<string> {
	const root = tree.root;
	await mkdir(join(root, "packages/lyra/src"), { recursive: true });
	await writeFile(
		join(root, "package.json"),
		JSON.stringify({ name: "fixture", devDependencies: { vitest: "1" } }),
	);
	await writeFile(
		join(root, "packages/lyra/package.json"),
		JSON.stringify({ name: "@autumnsgrove/lyra", exports: { ".": "./dist/index.js" } }),
	);
	await writeFile(join(root, "packages/lyra/src/index.ts"), "export const nothing = 1;\n");

	const playground = join(root, "packages/playground");
	await mkdir(playground, { recursive: true });
	await writeFile(
		join(playground, "package.json"),
		JSON.stringify(
			tree.playground === "no-src"
				? { name: "@autumnsgrove/lyra-playground" }
				: (tree.playground?.manifest ?? { name: "@autumnsgrove/lyra-playground" }),
		),
	);
	if (tree.playground !== "no-src") {
		await mkdir(join(playground, "src"), { recursive: true });
		for (const [name, content] of Object.entries(tree.playground?.files ?? {})) {
			await writeFile(join(playground, "src", name), content);
		}
	}
	return root;
}

async function withTree(tree: Tree, body: (root: string) => Promise<void>): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "lyra-host-app-"));
	try {
		await body(await fixture({ ...tree, root }));
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

/** The script's exit code and output, without throwing on a failure. */
async function check(root: string): Promise<{ code: number; output: string }> {
	try {
		const { stdout, stderr } = await run(process.execPath, [SCRIPT], {
			env: { ...process.env, LYRA_CHECK_ROOT: root },
		});
		return { code: 0, output: `${stdout}${stderr}` };
	} catch (cause) {
		const failed = cause as { code?: number; stdout?: string; stderr?: string };
		return { code: failed.code ?? 1, output: `${failed.stdout ?? ""}${failed.stderr ?? ""}` };
	}
}

test("a host app that imports a Node builtin is refused, naming the file", async () => {
	await withTree(
		{
			root: "",
			playground: { files: { "worker.ts": 'import "node:fs";\n' } },
		},
		async (root) => {
			const result = await check(root);
			expect(result.code).toBe(1);
			expect(result.output).toContain("worker.ts");
			expect(result.output).toContain("node:fs");
		},
	);
});

test("a host app that imports an undeclared package is refused", async () => {
	await withTree(
		{
			root: "",
			playground: { files: { "worker.ts": 'import yaml from "yaml";\nvoid yaml;\n' } },
		},
		async (root) => {
			const result = await check(root);
			expect(result.code).toBe(1);
			expect(result.output).toContain("not a Lyra entry point or a declared dependency");
		},
	);
});

test("a host app with no source to scan is a problem, not a quiet pass", async () => {
	await withTree({ root: "", playground: "no-src" }, async (root) => {
		const result = await check(root);
		expect(result.code).toBe(1);
		expect(result.output).toContain("no source files to scan");
	});
});

test("a clean host app passes, and the summary says how many files it read", async () => {
	await withTree(
		{
			root: "",
			playground: {
				manifest: {
					name: "@autumnsgrove/lyra-playground",
					dependencies: { "@autumnsgrove/lyra": "workspace:*" },
				},
				files: {
					"worker.ts": 'import { ok } from "@autumnsgrove/lyra";\nvoid ok;\n',
					"model.ts": "export const plane = 1;\n",
				},
			},
		},
		async (root) => {
			const result = await check(root);
			expect(result.code, result.output).toBe(0);
			expect(result.output).toContain("1 host app(s) over 2 file(s)");
		},
	);
});
