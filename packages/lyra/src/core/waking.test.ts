import { expect, test } from "vitest";

import { counterIds, memoryStorage, memoryWaking } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import {
	crashingStorage,
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolReturning,
	toolTakingTime,
	type ScriptedTurn,
} from "../testkit/index.js";
import { createRuntime, type Runtime } from "./runtime.js";
import type { RunHandle } from "./run-handle.js";
import { drive, until } from "./run-harness.testing.js";

/** The rows are in `docs/adapters.md`, the Waking slot's own table. */

const turns: ScriptedTurn[] = [
	{ toolCalls: [{ id: "c1", name: "slow" }] },
	{ toolCalls: [{ id: "c2", name: "finish" }] },
];

function tools(clock: ReturnType<typeof fakeClock>) {
	return [toolTakingTime("slow", 5_000, clock), createFinishTool()];
}

/** A start that the recipe's own input schema accepted. */
function started(result: ReturnType<Runtime["start"]>): RunHandle {
	if (!result.ok) {
		throw new Error(`the run did not start: ${result.error.message}`);
	}
	return result.value;
}

test("WAK01 a wake is set as a step begins, re-armed, and cancelled when the run ends", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	const waking = memoryWaking();
	const runtime = createRuntime({
		storage,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "test-host",
		waking: waking.slot,
	});

	const handle = started(
		runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: {
				name: "timeline",
				version: 1,
				instructions: "you are a test",
				tools: tools(clock),
			},
		}),
	);
	await until(() => waking.scheduled().length === 1);
	const first = waking.scheduled()[0];
	expect(first?.runId).toBe("run-1");
	// Set a minute ahead of the step, on the injected clock.
	expect(first?.atMs).toBe(clock.now() + 60_000);

	const outcome = await drive(clock, handle.outcome);
	expect(outcome.reason).toBe("done");
	// The run is over, so nothing is waiting to wake it.
	expect(waking.scheduled()).toEqual([]);
});

test("WAK02 an alarm that fires for a dead run resumes it", async () => {
	const clock = fakeClock();
	const inner = memoryStorage();
	const waking = memoryWaking();

	// A host that dies while saving the first tool's result, with its alarm set.
	const dying = crashingStorage(inner, { at: 5, when: "before" });
	void started(
		createRuntime({
			storage: dying,
			clock,
			ids: counterIds(),
			model: scriptedModel(turns, { clock }),
			host: "first-host",
			waking: waking.slot,
		}).start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: {
				name: "timeline",
				version: 1,
				instructions: "you are a test",
				tools: [
					toolReturning("slow", "the content", { safeToRepeat: true }),
					createFinishTool(),
				],
			},
		}),
	);
	await until(() => dying.appends() >= 5);

	// The alarm is what a host sees when the process is gone, so it is what it fires.
	const due = waking.fire();
	expect(due.map((wake) => wake.runId)).toEqual(["run-1"]);

	const second = createRuntime({
		storage: inner,
		clock,
		ids: counterIds(),
		model: scriptedModel(turns, { clock }),
		host: "second-host",
		waking: waking.slot,
	});
	const resumed = await second.wake({
		runId: "run-1",
		task: "test-task",
		definition: {
			name: "timeline",
			version: 1,
			instructions: "you are a test",
			tools: [
				toolReturning("slow", "the content", { safeToRepeat: true }),
				createFinishTool(),
			],
		},
	});
	expect(resumed.ok).toBe(true);
	if (resumed.ok) {
		expect((await resumed.value.outcome).reason).toBe("done");
	}

	const read = await inner.read();
	expect(read.ok).toBe(true);
	const loaded = loadRecord(read.ok ? read.value : []);
	expect(loaded.ok).toBe(true);
	const entries = loaded.ok ? loaded.value.entries : [];
	expect(
		entries.filter((entry) => entry.type === "status" && entry.state === "resumed"),
	).toHaveLength(1);
});
