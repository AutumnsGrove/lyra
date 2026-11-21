import { defineConfig } from "vitest/config";

// The live suite (decision 65). It is never part of `pnpm run ci`: every test here
// spends Autumn's allowance, needs a key in the environment, and skips loudly when
// there is none. Run it by hand with `pnpm test:live`.
export default defineConfig({
	test: {
		include: ["packages/lyra/live/**/*.test.ts"],
		environment: "node",
		// A live call waits on a real provider, so the timeouts are generous; the
		// budget caps inside each test are what stop a bad loop, not these.
		testTimeout: 180_000,
		hookTimeout: 30_000,
		// One at a time, so a recorded cassette cannot interleave with another test's.
		fileParallelism: false,
	},
});
