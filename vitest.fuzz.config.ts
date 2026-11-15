import { defineConfig } from "vitest/config";

// Fuzz and property targets live beside the code they exercise, as
// `*.fuzz.test.ts`. They run for a few seconds here and longer on demand, and
// the seed is printed when one fails. There are no targets yet: anything that
// parses untrusted bytes gets one as it is written (`AGENTS.md`).
export default defineConfig({
	test: {
		include: ["packages/*/src/**/*.fuzz.test.ts"],
		environment: "node",
		passWithNoTests: true,
	},
});
