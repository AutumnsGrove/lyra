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
		// A fuzz target runs a high `numRuns` on purpose, so the default five-second
		// test timeout measures the machine rather than the property (step 3, notes.md).
		// It went to 60 s in step 4, when RCD07 took 37 s on a loaded machine.
		testTimeout: 60_000,
	},
});
