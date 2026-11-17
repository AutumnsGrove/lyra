/**
 * Building a run out of a script, for every test that drives `runTask`.
 *
 * One harness for the loop's rows: a fake clock, counter ids, memory storage, a
 * scripted model, and the tools the test makes from the same clock. It is a
 * `.testing.ts` file so several suites share it without any of them running an
 * empty suite, and so no production file can import it.
 */

import { expect } from "vitest";

import { counterIds, memoryStorage, type MemoryStorage } from "../adapters/memory/index.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
import {
	fakeClock,
	scriptedModel,
	type FakeClock,
	type ScriptedModel,
	type ScriptedTurn,
} from "../testkit/index.js";
import type { Ids } from "./clock.js";
import type { RunEvent } from "./events.js";
import { runTask, type RunConfig, type RunResult } from "./run.js";
import type { Tool } from "./tool.js";

export interface RunHarness {
	clock: FakeClock;
	ids: Ids;
	storage: MemoryStorage;
	events: RunEvent[];
	model: ScriptedModel;
	tools: Tool[];
	run(overrides?: Partial<RunConfig>): Promise<RunResult>;
}

export function runHarness(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[],
): RunHarness {
	const clock = fakeClock();
	const ids = counterIds();
	const storage = memoryStorage();
	const events: RunEvent[] = [];
	const model = scriptedModel(turns, { clock });
	const tools = makeTools(clock);

	const run = async (overrides: Partial<RunConfig> = {}): Promise<RunResult> =>
		runTask({
			runId: "run-1",
			task: "test-task",
			host: "test-host",
			input: "do the thing",
			system: "you are a test",
			tools,
			model,
			storage,
			clock,
			ids,
			onEvent: (event) => {
				events.push(event);
			},
			...overrides,
		});

	return { clock, ids, storage, events, model, tools, run };
}

export async function readRecord(storage: MemoryStorage): Promise<LoadedRecord> {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	if (!read.ok) {
		throw new Error("the storage read failed");
	}
	const loaded = loadRecord(read.value);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		throw new Error(`the record did not load: ${loaded.error.message}`);
	}
	return loaded.value;
}

/** Let the microtask queue turn until a condition holds, instead of counting ticks. */
export async function until(check: () => boolean, limit = 500): Promise<void> {
	for (let tick = 0; tick < limit && !check(); tick += 1) {
		await Promise.resolve();
	}
}

/** Let a run that is waiting on the clock get as far as it can, moving time each turn. */
export async function drive<T>(clock: FakeClock, running: Promise<T>, stepMs = 100): Promise<T> {
	let done = false;
	void running.then(
		() => {
			done = true;
		},
		() => {
			done = true;
		},
	);
	for (let tick = 0; tick < 100 && !done; tick += 1) {
		await Promise.resolve();
		clock.advance(stepMs);
		await Promise.resolve();
	}
	return running;
}
