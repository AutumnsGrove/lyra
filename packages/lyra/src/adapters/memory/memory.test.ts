import { expect, test } from "vitest";

import { storageContract } from "../../testing/storage.contract.testing.js";
import { counterIds } from "./ids.js";
import { memorySecrets } from "./secrets.js";
import { memoryStorage } from "./storage.js";
import { memoryWaking } from "./waking.js";

/** The shared storage cases, so this adapter and the Cloudflare one agree. */
storageContract({ name: "memory", create: (options) => memoryStorage(options) });

test("STO05 counter ids count up per prefix, so the same script names the same things", () => {
	const ids = counterIds();
	expect([ids.next("c"), ids.next("c"), ids.next("e"), ids.next("c")]).toEqual([
		"c1",
		"c2",
		"e1",
		"c3",
	]);

	// A second source starts again, which is what makes two runs comparable.
	expect(counterIds().next("c")).toBe("c1");
	expect([...Array(3)].map(() => counterIds().next("c"))).toEqual(["c1", "c1", "c1"]);
});

test("secrets are read by name, and an unheld name is nothing rather than an error", async () => {
	const secrets = memorySecrets({ GITHUB_TOKEN: "made-up-for-a-test" });
	expect(await secrets.get("GITHUB_TOKEN")).toBe("made-up-for-a-test");
	expect(await secrets.get("OPENROUTER_API_KEY")).toBeUndefined();

	secrets.set("OPENROUTER_API_KEY", "also-made-up");
	expect(await secrets.get("OPENROUTER_API_KEY")).toBe("also-made-up");
});

test("waking records what was scheduled, replaces a second schedule, and forgets a cancel", async () => {
	const waking = memoryWaking();
	await waking.slot.schedule("run-1", 1_000);
	await waking.slot.schedule("run-2", 2_000);
	expect(waking.scheduled()).toEqual([
		{ runId: "run-1", atMs: 1_000 },
		{ runId: "run-2", atMs: 2_000 },
	]);

	// A run that parks twice has one wake, not two.
	await waking.slot.schedule("run-1", 3_000);
	expect(waking.scheduled()).toEqual([
		{ runId: "run-1", atMs: 3_000 },
		{ runId: "run-2", atMs: 2_000 },
	]);

	await waking.slot.cancel("run-1");
	expect(waking.fire()).toEqual([{ runId: "run-2", atMs: 2_000 }]);
	// Firing takes them: they do not fire again.
	expect(waking.scheduled()).toEqual([]);
});
