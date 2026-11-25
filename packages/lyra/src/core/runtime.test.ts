import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { encodeEntry } from "../record/entries.js";
import { loadRecord } from "../record/load.js";
import type { RecordEntry } from "../record/entries.js";
import {
	crashingStorage,
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolReturning,
	toolTakingTime,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { createRuntime, type RunDefinition, type Runtime } from "./runtime.js";
import type { RunHandle } from "./run-handle.js";
import { drive, until } from "./run-harness.testing.js";
import type { StorageSlot } from "./slots.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 6)". */

/** A start that the recipe's own input schema accepted. */
function started(result: ReturnType<Runtime["start"]>): RunHandle {
	if (!result.ok) {
		throw new Error(`the run did not start: ${result.error.message}`);
	}
	return result.value;
}

interface RuntimeHarness {
	clock: FakeClock;
	storage: ReturnType<typeof memoryStorage>;
	model: ReturnType<typeof scriptedModel>;
	runtime: Runtime;
	definition: RunDefinition;
}

function runtimeHarness(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[],
): RuntimeHarness {
	const clock = fakeClock();
	const storage = memoryStorage();
	const model = scriptedModel(turns, { clock });
	const definition: RunDefinition = {
		name: "timeline",
		version: 1,
		instructions: "you are a test",
		tools: makeTools(clock),
	};
	return {
		clock,
		storage,
		model,
		runtime: createRuntime({
			storage,
			clock,
			ids: counterIds(),
			model,
			host: "test-host",
		}),
		definition,
	};
}

async function entriesOf(storage: StorageSlot) {
	const read = await storage.read();
	expect(read.ok).toBe(true);
	if (!read.ok) {
		return [] as RecordEntry[];
	}
	const loaded = loadRecord(read.value);
	expect(loaded.ok).toBe(true);
	return loaded.ok ? loaded.value.entries : ([] as RecordEntry[]);
}

/** Start a run that stops in the middle of a tool, and wait for the stop to land. */
async function stoppedRun(harness: RuntimeHarness) {
	const handle = started(
		harness.runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: harness.definition,
		}),
	);
	await until(() =>
		(harness.storage.saved() as string[]).some((line) => line.includes("assistant_message")),
	);
	handle.abort();
	const outcome = await handle.outcome;
	expect(outcome).toMatchObject({ reason: "parked", parkedReason: "stopped" });
	return outcome;
}

test("RSM03 a wake leaves a person's stop alone, and a person may continue it", async () => {
	const harness = runtimeHarness(
		[
			{ toolCalls: [{ id: "c1", name: "slow" }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 60_000, clock), createFinishTool()],
	);
	await stoppedRun(harness);
	const before = harness.storage.saved().length;

	// An alarm is not a person: the record is still parked, with nothing written.
	const woken = await harness.runtime.wake({
		runId: "run-1",
		task: "test-task",
		definition: harness.definition,
	});
	expect(woken.ok).toBe(true);
	if (woken.ok) {
		expect(await woken.value.outcome).toMatchObject({
			reason: "parked",
			parkedReason: "stopped",
		});
	}
	expect(harness.storage.saved()).toHaveLength(before);

	// A person may continue it, and the run picks up at the next turn.
	const resumed = await harness.runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition: harness.definition,
		by: "person",
	});
	expect(resumed.ok).toBe(true);
	if (resumed.ok) {
		expect((await resumed.value.outcome).reason).toBe("done");
	}
});

test("RSM03 a wake on a live run does nothing, and joins the run it found", async () => {
	const harness = runtimeHarness(
		[
			{ toolCalls: [{ id: "c1", name: "slow" }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 30_000, clock), createFinishTool()],
	);
	const handle = started(
		harness.runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: harness.definition,
		}),
	);
	await until(() => harness.model.requests.length === 1);
	expect(harness.model.requests).toHaveLength(1);
	// The registry is what a wake consults, and this run is in it.
	expect(harness.runtime.active("run-1")).toBe(handle);

	const woken = await harness.runtime.wake({
		runId: "run-1",
		task: "test-task",
		definition: harness.definition,
	});
	expect(woken.ok).toBe(true);
	// The alarm joined the run that was already here rather than starting a rival.
	if (woken.ok) {
		expect(woken.value).toBe(handle);
	}
	harness.clock.advance(30_000);
	expect((await handle.outcome).reason).toBe("done");
	// Exactly one model turn was spent on the work, not two.
	expect(harness.model.requests.length).toBeLessThanOrEqual(2);
});

test("RSM03 an alarm that fires twice resumes the run once", async () => {
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "read" }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];
	// A first host that died while saving the tool's result, so the record is `running`.
	const clock = fakeClock();
	const inner = memoryStorage();
	const dying = crashingStorage(inner, { at: 5, when: "before" });
	void started(
		createRuntime({
			storage: dying,
			clock,
			ids: counterIds(),
			model: scriptedModel(turns, { clock }),
			host: "first-host",
		}).start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: {
				name: "timeline",
				version: 1,
				instructions: "you are a test",
				tools: [
					toolReturning("read", "the content", { safeToRepeat: true }),
					createFinishTool(),
				],
			},
		}),
	);
	await until(() => dying.appends() >= 5);

	const model = scriptedModel(turns, { clock });
	const runtime = createRuntime({
		storage: inner,
		clock,
		ids: counterIds(),
		model,
		host: "second-host",
	});
	const request = {
		runId: "run-1",
		task: "test-task",
		definition: {
			name: "timeline",
			version: 1,
			instructions: "you are a test",
			tools: [
				toolReturning("read", "the content", { safeToRepeat: true }),
				createFinishTool(),
			],
		},
	};

	const [first, second] = await Promise.all([runtime.wake(request), runtime.wake(request)]);
	expect(first.ok).toBe(true);
	expect(second.ok).toBe(true);
	if (first.ok && second.ok) {
		expect(second.value).toBe(first.value);
		await first.value.outcome;
	}

	const entries = await entriesOf(inner);
	expect(
		entries.filter((entry) => entry.type === "status" && entry.state === "resumed"),
	).toHaveLength(1);
});

test("RSM04 a resume with no record is not_found, and a broken record fails cleanly", async () => {
	const harness = runtimeHarness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
		createFinishTool(),
	]);

	const missing = await harness.runtime.resume({
		runId: "never-started",
		task: "test-task",
		definition: harness.definition,
	});
	expect(missing.ok).toBe(false);
	expect(missing.ok ? "" : missing.error.code).toBe("not_found");

	const broken = memoryStorage();
	await broken.append('{"not":"a header"}');
	const runtime = createRuntime({
		storage: broken,
		clock: harness.clock,
		ids: counterIds(),
		model: harness.model,
		host: "test-host",
	});
	const refused = await runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition: harness.definition,
	});
	expect(refused.ok).toBe(true);
	if (refused.ok) {
		const outcome = await refused.value.outcome;
		expect(outcome.reason).toBe("failed");
		expect(outcome.reason === "failed" ? outcome.error?.code : "").toBe("internal");
	}
});

test("RSM06 a person resumes a model_unavailable park with the same definition", async () => {
	const failures = Array.from({ length: 4 }, () => ({
		code: "provider_error" as const,
		message: "the provider is down",
		retryable: true,
	}));
	const harness = runtimeHarness(
		[{ toolCalls: [{ id: "c1", name: "finish" }], failures }],
		() => [createFinishTool()],
	);

	const handle = started(
		harness.runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: harness.definition,
		}),
	);
	// Move the clock past every retry delay.
	const parked = await drive(harness.clock, handle.outcome, 20_000);
	expect(parked).toMatchObject({
		reason: "parked",
		parkedReason: "model_unavailable",
	});

	const resumed = await harness.runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition: harness.definition,
	});
	expect(resumed.ok).toBe(true);
	if (resumed.ok) {
		// The failures were spent, so the same turn now answers and the run finishes.
		expect((await resumed.value.outcome).reason).toBe("done");
	}
});

test("RSM06 a person resumes a limit park with new limits and a stuck park", async () => {
	const limited = runtimeHarness(
		[
			{ toolCalls: [{ id: "c1", name: "read" }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [toolReturning("read", "the content"), createFinishTool()],
	);
	const stopped = started(
		limited.runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: { ...limited.definition, limits: { steps: 1 } },
		}),
	);
	expect(await stopped.outcome).toMatchObject({ reason: "parked", parkedDetail: "steps" });

	const lifted = await limited.runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition: limited.definition,
		limits: { steps: 3 },
	});
	expect(lifted.ok).toBe(true);
	if (lifted.ok) {
		expect((await lifted.value.outcome).reason).toBe("done");
	}

	// A stuck run is the same kind of park: a person's resume is the decision to go on.
	const silentForever = runtimeHarness(
		[
			{ text: "nothing to say" },
			{ text: "still nothing" },
			{ text: "nothing at all" },
			{ toolCalls: [{ id: "c1", name: "finish" }] },
		],
		() => [createFinishTool()],
	);
	const stuck = started(
		silentForever.runtime.start({
			runId: "run-1",
			task: "test-task",
			input: "go",
			definition: silentForever.definition,
		}),
	);
	expect(await stuck.outcome).toMatchObject({
		reason: "parked",
		parkedDetail: "stopped_without_finishing",
	});

	const continued = await silentForever.runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition: silentForever.definition,
	});
	expect(continued.ok).toBe(true);
	if (continued.ok) {
		expect((await continued.value.outcome).reason).toBe("done");
	}
});

test("CMD22 a follow-up whose real entry fits the cap is accepted, and one that does not is refused", async () => {
	// The size is measured with the record's own last id as the parent, so a text
	// that fits by a few bytes is not turned away on a guess about id length.
	const cap = 4096;
	const clock = fakeClock();
	const storage = memoryStorage({ maxLineBytes: cap });
	const model = scriptedModel(
		[
			{ toolCalls: [{ id: "c1", name: "finish" }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		{ clock },
	);
	const definition: RunDefinition = {
		name: "test-task",
		version: 1,
		instructions: "you are a test",
		tools: [createFinishTool()],
	};
	const runtime = createRuntime({ storage, clock, ids: counterIds(), model, host: "h" });
	const first = started(
		runtime.start({ runId: "run-1", task: "test-task", input: "go", definition }),
	);
	await first.outcome;
	const last = (await entriesOf(storage)).at(-1);

	// The most text a 39-byte id and the real parent leave room for, which is the
	// largest an id may be (decision 85): anything real is at most this size.
	const withText = (text: string): string =>
		encodeEntry({
			type: "user_message",
			id: "e".repeat(39),
			parent: last?.id ?? null,
			ts: clock.now(),
			label: "follow_up",
			text,
		});
	const room = cap - withText("").length;

	const fits = await runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition,
		by: "person",
		followUp: "y".repeat(room),
	});
	expect(fits.ok).toBe(true);
	if (fits.ok) {
		await fits.value.outcome;
	}

	// One byte past the room is the smallest text that no longer fits, so the refusal
	// is at the bound itself and not only well beyond it.
	const justOver = await runtime.resume({
		runId: "run-1",
		task: "test-task",
		definition,
		by: "person",
		followUp: "y".repeat(room + 1),
	});
	expect(justOver.ok ? "" : justOver.error.code).toBe("bad_request");
});

test("CMD22 an oversized follow-up for a run with no record is still not_found", async () => {
	const harness = runtimeHarness([], () => [createFinishTool()]);
	const refused = await harness.runtime.resume({
		runId: "nope",
		task: "test-task",
		definition: harness.definition,
		by: "person",
		followUp: "y".repeat(2 * 1024 * 1024),
	});
	expect(refused.ok ? "" : refused.error.code).toBe("not_found");
});
