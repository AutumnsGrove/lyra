import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/** An entry point of the package under test, as a path the runner can resolve. */
function source(entry: string): string {
	return fileURLToPath(new URL(`packages/lyra/src/${entry}`, import.meta.url));
}

// The fast loop. Everything here runs on Node, deterministically: a fake clock,
// no real sleeps, and no network except the testkit's local servers.
// The worker-runtime half (L4) gets its own config and joins `pnpm ci` with the
// Cloudflare adapter in step 4 of `docs/first-slice.md`.
export default defineConfig({
	// Tests import the package by name the way a host does, so the runner resolves it
	// to the source rather than to `dist/`. Without this a test could only run after a
	// build, which would make the slow half of the gate depend on the fast half — the
	// one thing the split exists to avoid (the playground's tests found this).
	resolve: {
		alias: [
			{ find: /^@autumnsgrove\/lyra$/, replacement: source("index.ts") },
			{
				find: /^@autumnsgrove\/lyra\/cloudflare$/,
				replacement: source("adapters/cloudflare/index.ts"),
			},
			{
				find: /^@autumnsgrove\/lyra\/memory$/,
				replacement: source("adapters/memory/index.ts"),
			},
			{
				find: /^@autumnsgrove\/lyra\/openai$/,
				replacement: source("adapters/openai/index.ts"),
			},
			{ find: /^@autumnsgrove\/lyra\/testkit$/, replacement: source("testkit/index.ts") },
		],
	},
	test: {
		include: ["packages/*/src/**/*.test.ts", "scripts/**/*.test.ts"],
		exclude: ["**/*.fuzz.test.ts", "**/*.workers.test.ts", "**/node_modules/**"],
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			exclude: [
				"**/*.test.ts",
				"**/*.fuzz.test.ts",
				"**/*.testing.ts",
				"**/dist/**",
				// The Cloudflare adapter is tested in workerd, where V8 coverage is not
				// available (decision 101), so the 85% floor measures the Node-tested core.
				"packages/lyra/src/adapters/cloudflare/**",
			],
			reporter: ["text"],
			thresholds: {
				lines: 85,
				functions: 85,
				branches: 85,
				statements: 85,
			},
		},
	},
});
