import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import type { RecordEntry } from "../record/entries.js";
import { loadRecord } from "../record/load.js";
import { createFinishTool, fakeClock, scriptedModel, toolReturning } from "../testkit/index.js";
import { runTask, type RunConfig } from "./run.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/run-record.md`, REC05 to REC09. */

const readDefault: Tool = { ...toolReturning("read", "the content"), safeToRepeat: true };

function pinHarness(overrides: { system?: string; tools?: Tool[] } = {}) {
	const clock = fakeClock();
	const ids = counterIds();
	const storage = memoryStorage();
	const tools = overrides.tools ?? [readDefault, createFinishTool()];
	const turns = [
		{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];

	const config = (overrides2: Partial<RunConfig> = {}): RunConfig => ({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "go",
		system: overrides.system ?? "you are a test",
		tools,
		model: scriptedModel(turns, { clock }),
		storage,
		clock,
		ids,
		recipe: { name: "timeline", version: 1 },
		...overrides2,
	});

	return {
		clock,
		storage,
		config,
		run: (extra: Partial<RunConfig> = {}) => runTask(config(extra)),
	};
}

/** A run that used `read` and then parked on its step limit, ready to be resumed. */
async function parked(overrides: { system?: string; tools?: Tool[] } = {}) {
	const harness = pinHarness(overrides);
	const first = await harness.run({ limits: { steps: 1 } });
	expect(first).toMatchObject({ reason: "parked", parkedReason: "limit" });
	const read = await harness.storage.read();
	expect(read.ok).toBe(true);
	return { harness, lines: read.ok ? read.value : [] };
}

async function entriesOf(harness: {
	storage: ReturnType<typeof memoryStorage>;
}): Promise<RecordEntry[]> {
	const read = await harness.storage.read();
	expect(read.ok).toBe(true);
	if (!read.ok) {
		return [];
	}
	const loaded = loadRecord(read.value);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : [];
}

test("REC05 the same tools and version continue with no extra entry", async () => {
	const { harness, lines } = await parked();
	const resumed = await harness.run({ resume: { lines, by: "person" } });

	expect(resumed.reason).toBe("done");
	const entries = await entriesOf(harness);
	expect(entries.some((entry) => entry.type === "recipe_updated")).toBe(false);
});

test("REC06 a new version continues and the record notes the change", async () => {
	const { harness, lines } = await parked();
	const resumed = await harness.run({
		recipe: { name: "timeline", version: 2 },
		resume: { lines, by: "person" },
	});

	expect(resumed.reason).toBe("done");
	const updated = (await entriesOf(harness)).filter((entry) => entry.type === "recipe_updated");
	expect(updated).toHaveLength(1);
	expect(updated[0]).toMatchObject({
		type: "recipe_updated",
		from: { name: "timeline", version: 1 },
		to: { name: "timeline", version: 2 },
	});
});

test("REC06 reworded instructions alone continue and are noted", async () => {
	const { harness, lines } = await parked();
	const resumed = await harness.run({
		system: "you are a test, and you write more carefully now",
		resume: { lines, by: "person" },
	});

	expect(resumed.reason).toBe("done");
	const updated = (await entriesOf(harness)).filter((entry) => entry.type === "recipe_updated");
	expect(updated).toHaveLength(1);
	const first = updated[0];
	if (first?.type === "recipe_updated") {
		expect(first.from?.instructionsHash).not.toBe(first.to.instructionsHash);
		expect(first.from?.version).toBe(first.to.version);
	}
});

test("REC07 a tool removed that the record used parks, naming it", async () => {
	const { harness, lines } = await parked({
		tools: [readDefault, createFinishTool()],
	});
	// The recipe loses `read`, which the first segment already called.
	const resumed = await harness.run({
		tools: [createFinishTool()],
		resume: { lines, by: "person" },
	});

	expect(resumed).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "recipe_changed: removed read (was used)",
	});
	const entries = await entriesOf(harness);
	expect(entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "stuck",
		detail: "recipe_changed: removed read (was used)",
	});
});

test("REC08 a tool whose arguments changed parks, naming it", async () => {
	const { harness, lines } = await parked();
	// The same tool with a different argument schema, which is what a deploy can do.
	const changed: Tool = {
		spec: {
			name: "read",
			description: readDefault.spec.description,
			parameters: { type: "object", properties: { path: { type: "string" } } },
		},
		execute: readDefault.execute,
	};
	const resumed = await harness.run({
		tools: [changed, createFinishTool()],
		resume: { lines, by: "person" },
	});

	expect(resumed).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "recipe_changed: changed read",
	});
});

test("REC09 a resume after a recipe change continues and becomes the new pin", async () => {
	const { harness, lines } = await parked();
	const newTools = [createFinishTool()];

	// The first resume parks: nobody has said the new tool set is the right one.
	const refused = await harness.run({ tools: newTools, resume: { lines, by: "person" } });
	expect(refused).toMatchObject({
		reason: "parked",
		parkedDetail: expect.stringContaining("recipe_changed"),
	});

	// The second resume is that decision, so it continues with the new tools.
	const read = await harness.storage.read();
	expect(read.ok).toBe(true);
	const accepted = await harness.run({
		tools: newTools,
		resume: { lines: read.ok ? read.value : [], by: "person" },
	});
	expect(accepted.reason).toBe("done");

	const entries = await entriesOf(harness);
	const updated = entries.filter((entry) => entry.type === "recipe_updated");
	expect(updated).toHaveLength(1);
	expect(updated[0]).toMatchObject({
		type: "recipe_updated",
		to: { name: "timeline", version: 1 },
	});

	// A third resume compares against the entry, not the header: nothing moved.
	const again = await harness.storage.read();
	const settled = await harness.run({
		tools: newTools,
		resume: { lines: again.ok ? again.value : [], by: "person" },
	});
	expect(settled.reason).toBe("done");
	expect(
		(await entriesOf(harness)).filter((entry) => entry.type === "recipe_updated"),
	).toHaveLength(1);
});
