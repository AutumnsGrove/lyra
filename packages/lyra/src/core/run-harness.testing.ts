/**
 * Building a run out of a script, for every test that drives `runTask`.
 *
 * One harness for the loop's rows: a fake clock, counter ids, memory storage, a
 * scripted model, and the tools the test makes from the same clock. It is a
 * `.testing.ts` file so several suites share it without any of them running an
 * empty suite, and so no production file can import it.
 */

import { expect, vi } from "vitest";

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

/**
 * Let the event loop turn, not just the microtask queue. `crypto.subtle` finishes
 * off-thread, so a run that pins its recipe is not observable from a microtask-only
 * wait and a poll would spin past it. Vitest's own timer is the one real timer
 * available to a file under `src/`, where the project bans `setTimeout` so no test
 * can sleep on the clock it is testing.
 */
async function eventLoopTurn(): Promise<void> {
	let first = true;
	await vi
		.waitFor(
			() => {
				if (first) {
					first = false;
					throw new Error("one turn");
				}
			},
			{ interval: 1, timeout: 100 },
		)
		.catch(() => undefined);
}

/** Let the event loop turn until a condition holds, instead of counting ticks. */
export async function until(check: () => boolean, limit = 200): Promise<void> {
	for (let tick = 0; tick < limit && !check(); tick += 1) {
		await eventLoopTurn();
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
	for (let tick = 0; tick < 200 && !done; tick += 1) {
		clock.advance(stepMs);
		await eventLoopTurn();
	}
	return running;
}
