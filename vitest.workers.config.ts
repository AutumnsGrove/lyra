import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The worker-runtime half of the gate (docs/implementation/04-cloudflare-adapter.md,
// decision 101). Everything here runs in workerd through Miniflare, so a Durable
// Object is a real one, its SQLite storage is real, and eviction is faithful.
//
// V8 coverage does not work in workerd, so this suite asks for none; the 85% floor
// stays on the Node run, which is where the core lives.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./packages/lyra/src/adapters/cloudflare/testing/wrangler.jsonc",
			},
		}),
	],
	test: {
		include: ["packages/lyra/src/adapters/cloudflare/**/*.workers.test.ts"],
		// The socket files have their own config below, because WebSockets under Durable
		// Objects cannot run with per-file isolation (decision 101). Without this they
		// would also run here, isolation on, and flake exactly where that decision says
		// they cannot work.
		exclude: ["**/*.ws.workers.test.ts", "**/node_modules/**"],
		// Booting the first worker is the slow part; a test itself is milliseconds.
		testTimeout: 60_000,
	},
});
