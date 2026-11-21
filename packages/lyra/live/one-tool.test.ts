/**
 * One real call with a tool, through each provider (`docs/first-slice.md`, step 5).
 *
 * This is the only test that spends money, and it spends as little as it can: a
 * four-step limit, a token limit, a time limit, and one tool that answers from a
 * string. It is opt-in twice over — it is not in `pnpm run ci`, and it skips
 * loudly without a key — and it never prints one.
 *
 * With `RECORD=1` the exchange is also written to `cassettes/`, scrubbed, for CI
 * to replay free.
 */

import { expect, test } from "vitest";

import { counterIds } from "../src/adapters/memory/ids.ts";
import { memoryStorage } from "../src/adapters/memory/storage.ts";
import { openCodeGo, openRouter } from "../src/adapters/openai/index.ts";
import type { FetchLike } from "../src/adapters/openai/model.ts";
import type { ModelSlot } from "../src/core/model.ts";
import type { RunEvent } from "../src/core/events.ts";
import { runTask } from "../src/core/run.ts";
import { loadRecord } from "../src/record/load.ts";
import { systemClock } from "../src/core/system-clock.ts";
import { createFinishTool, recordingFetch, toolReturning } from "../src/testkit/index.ts";
import { liveSecrets } from "./env.ts";
import { cassettePath, writeCassette } from "./recorder.ts";

const BUDGET = { steps: 4, tokens: 20_000, timeMs: 120_000 } as const;

interface LiveCase {
	name: string;
	key: string;
	model: string | undefined;
	make: (options: { model: string; fetch?: FetchLike }) => ModelSlot;
}

// DeepSeek V4.1 Flash, because it speaks chat completions and its allowance goes
// furthest (Autumn's call, 2026-11-19: kimi-k3 is far too expensive per quota).
const opencodeModel = process.env["OPENCODE_GO_MODEL"] ?? "deepseek-v4.1-flash";
const openrouterModel = process.env["OPENROUTER_MODEL"];

const cases: LiveCase[] = [
	{
		// The default provider for bulk testing: an allowance, not a bill.
		name: "opencode-go",
		key: "OPENCODE_GO_API_KEY",
		model: opencodeModel,
		make: ({ model, fetch }) =>
			openCodeGo({
				model,
				session: `lyra-live-${Date.now()}`,
				secrets: liveSecrets,
				// The real clock: a deadline or a retry backoff on a fake clock nobody
				// advances would never fire, and a 429 would hang the suite instead.
				clock: systemClock(),
				...(fetch === undefined ? {} : { fetch }),
			}),
	},
	{
		// Production fidelity: the model that runs in Grove, through OpenRouter.
		name: "openrouter",
		key: "OPENROUTER_API_KEY",
		model: openrouterModel,
		make: ({ model, fetch }) =>
			openRouter({
				model,
				secrets: liveSecrets,
				clock: systemClock(),
				...(fetch === undefined ? {} : { fetch }),
			}),
	},
];

for (const live of cases) {
	const key = process.env[live.key];
	const hasKey = key !== undefined && key.trim() !== "";
	const ready = hasKey && live.model !== undefined;
	if (!hasKey) {
		// Loud on purpose: a silent skip reads like a passing suite.
		console.warn(`live: skipping ${live.name}, ${live.key} is not set`);
	} else if (live.model === undefined) {
		console.warn(`live: skipping ${live.name}, its model id is not set`);
	}

	// Registered either way, and skipped rather than absent: a file with no tests in
	// it is a failure in Vitest, which would make the keyless run red instead of loud.
	// The reason is in the title, so a reported skip says why without needing a log.
	const reason = !hasKey ? `${live.key} is not set` : "its model id is not set";
	test.skipIf(!ready)(
		ready
			? `a real call with a tool through ${live.name}`
			: `a real call with a tool through ${live.name} (skipped: ${reason})`,
		async () => {
			const clock = systemClock();
			const storage = memoryStorage();
			const events: RunEvent[] = [];
			let fetchLike: FetchLike = globalThis.fetch;
			let recorder: ReturnType<typeof recordingFetch> | undefined;
			if (process.env["RECORD"] === "1") {
				recorder = recordingFetch((url, init) => globalThis.fetch(url, init), {
					note: `recorded live through ${live.name} on ${new Date().toISOString()}`,
				});
				fetchLike = recorder;
			}

			const result = await runTask({
				runId: `${live.name}-live`,
				task: "live-one-tool",
				host: "live-test",
				input: "Read /hello.txt with the read tool, then finish.",
				system: "You are being tested. Call read once, then call finish.",
				tools: [toolReturning("read", "hello from the file"), createFinishTool()],
				model: live.make({ model: live.model ?? "", fetch: fetchLike }),
				storage,
				clock,
				ids: counterIds(),
				limits: BUDGET,
				toolDeadlineMs: 30_000,
				onEvent: (event) => {
					events.push(event);
				},
			});

			// A park on a limit is not a failure of the adapter, so it is allowed here;
			// what must not happen is a `failed` run or a thrown exception.
			expect(result.reason).not.toBe("failed");
			expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
			expect(result.usage.inputTokens).toBeGreaterThan(0);

			const saved = await storage.read();
			expect(saved.ok).toBe(true);
			if (!saved.ok) {
				return;
			}
			const record = loadRecord(saved.value);
			expect(record.ok).toBe(true);
			if (record.ok) {
				// One real call did reach the tool: the point of the step.
				const call = record.value.entries.find(
					(entry) => entry.type === "assistant_message" && entry.toolCalls.length > 0,
				);
				expect(call).toBeDefined();
			}

			if (recorder !== undefined) {
				await writeCassette(recorder.cassette(), cassettePath(`${live.name}-one-tool`));
			}
		},
	);
}
