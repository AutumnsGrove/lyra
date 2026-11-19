import { defineConfig } from "vitest/config";

// The fast loop. Everything here runs on Node, deterministically: a fake clock,
// no real sleeps, and no network except the testkit's local servers.
// The worker-runtime half (L4) gets its own config and joins `pnpm ci` with the
// Cloudflare adapter in step 4 of `docs/first-slice.md`.
export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.test.ts"],
		exclude: ["**/*.fuzz.test.ts", "**/*.workers.test.ts", "**/node_modules/**"],
		environment: "node",
		coverage: {
			provider: "v8",
			include: ["packages/*/src/**/*.ts"],
			exclude: ["**/*.test.ts", "**/*.fuzz.test.ts", "**/*.testing.ts", "**/dist/**"],
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
