import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The WebSocket half of the workers suite (docs/implementation/08-websocket.md,
// decision 101). WebSockets under Durable Objects are unsupported with per-file
// storage isolation, so these files run in one worker with isolation off, and
// every test uses a fresh session id because storage is shared between them.
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: {
				configPath: "./packages/lyra/src/adapters/cloudflare/testing/wrangler.jsonc",
			},
		}),
	],
	test: {
		include: ["packages/lyra/src/adapters/cloudflare/**/*.ws.workers.test.ts"],
		// One worker, no per-file isolation: the constraint the step document names.
		isolate: false,
		maxWorkers: 1,
		fileParallelism: false,
		testTimeout: 60_000,
	},
});
