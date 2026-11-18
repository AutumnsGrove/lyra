import fc from "fast-check";
import { expect, test } from "vitest";

import { counterIds, memoryStorage, type MemoryStorage } from "../adapters/memory/index.js";
import { loadRecord } from "../record/load.js";
import { replayConversation } from "../record/replay.js";
import type { RecordEntry } from "../record/entries.js";
import {
	crashingStorage,
	createFinishTool,
	executionCounter,
	fakeClock,
	scriptedModel,
	toolReturning,
	type Executions,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { createRun } from "./run-handle.js";
import { runTask, type RunConfig } from "./run.js";
import { until } from "./run-harness.testing.js";
import type { Tool } from "./tool.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 6)". */

interface CrashHarness {
	clock: FakeClock;
	inner: MemoryStorage;
	turns: readonly ScriptedTurn[];
	tools: Tool[];
	setup: Omit<RunConfig, "storage" | "model" | "resume" | "signal" | "onEvent">;
}

function crashHarness(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[],
): CrashHarness {
	const clock = fakeClock();
	const tools = makeTools(clock);
	return {
		clock,
		inner: memoryStorage(),
		turns,
		tools,
		setup: {
			runId: "run-1",
			task: "test-task",
			host: "test-host",
			input: "do the thing",
			system: "you are a test",
			tools,
			clock,
			ids: counterIds(),
		},
	};
}

/** Run until the chosen append dies, then hand back exactly what was saved. */
async function dieAt(
	harness: CrashHarness,
	at: number,
	when: "before" | "after",
): Promise<string[]> {
	const dying = crashingStorage(harness.inner, { at, when });
	void runTask({
		...harness.setup,
		// A fresh scripted model for the crash run, as a first host would have.
		model: scriptedModel(harness.turns, { clock: harness.clock }),
		storage: dying,
	});
	await until(() => dying.appends() >= at);
	// Let anything already scheduled settle, so this is exactly what the kill left.
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const read = await harness.inner.read();
	expect(read.ok).toBe(true);
	return read.ok ? read.value : [];
}

/** Resume the record on the same storage, as a restarted host would. */
async function resume(
	harness: CrashHarness,
	lines: string[],
	onEvent?: RunConfig["onEvent"],
): Promise<Awaited<ReturnType<typeof runTask>>> {
	return runTask({
		...harness.setup,
		// A new model instance is what a restarted host looks like (KIT03).
		model: scriptedModel(harness.turns, { clock: harness.clock }),
		storage: harness.inner,
		resume: { lines, by: "person" },
		...(onEvent === undefined ? {} : { onEvent }),
	});
}

/**
 * A record reduced to what a caller can see, with the two differences a resume is
 * allowed to make taken out: the `resumed` status, and an unanswered call answered
 * as an unknown outcome.
 */
function projection(entries: readonly RecordEntry[]): string[] {
	const lines: string[] = [];
	for (const entry of entries) {
		switch (entry.type) {
			case "status":
				// Progress, not content: a resume writes `resumed` where the run would
				// have gone on, and where the kill landed changes which statuses exist.
				continue;
			case "user_message":
				lines.push(`user ${entry.label} ${entry.text}`);
				break;
			case "assistant_message":
				lines.push(
					`assistant ${entry.text} ${entry.toolCalls
						.map((call) => `${call.id}/${call.name}/${call.arguments}`)
						.join(",")} ${entry.finishReason} ${entry.retries ?? 0}`,
				);
				break;
			case "tool_message":
				if (entry.content.startsWith("outcome unknown:")) {
					continue;
				}
				lines.push(
					`tool ${entry.toolCallId} ${entry.isError} ${entry.content} ${entry.done === true}`,
				);
				break;
			default:
				lines.push(entry.type);
		}
	}
	return lines;
}

function entriesOf(lines: string[]): RecordEntry[] {
	const loaded = loadRecord(lines);
	expect(loaded.ok).toBe(true);
	if (!loaded.ok) {
		throw new Error(`the record did not load: ${loaded.error.message}`);
	}
	return loaded.value.entries;
}

const readTool = (name: string): Tool =>
	toolReturning(name, `${name} done`, { safeToRepeat: true });
const safeFinish = (): Tool => ({ ...createFinishTool(), safeToRepeat: true });

test("RSM01 killed at every append, both ways, the resumed record matches the uninterrupted one", async () => {
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "read", args: { n: 1 } }] },
		{ toolCalls: [{ id: "c2", name: "look", args: {} }] },
		{ toolCalls: [{ id: "c3", name: "finish" }] },
	];
	const makeTools = (): Tool[] => [readTool("read"), readTool("look"), safeFinish()];

	// The uninterrupted run, for the record it should match.
	const whole = crashHarness(turns, makeTools);
	const uninterrupted = await runTask({
		...whole.setup,
		model: scriptedModel(turns, { clock: whole.clock }),
		storage: whole.inner,
	});
	expect(uninterrupted.reason).toBe("done");
	const read = await whole.inner.read();
	expect(read.ok).toBe(true);
	const expected = projection(entriesOf(read.ok ? read.value : []));

	// The first append is the header: a kill before it leaves no record at all, which
	// is RSM04's `not_found`, so this row starts at the second append.
	const appends = read.ok ? read.value.length : 0;
	for (let at = 2; at <= appends; at += 1) {
		for (const when of ["before", "after"] as const) {
			const harness = crashHarness(turns, makeTools);
			const lines = await dieAt(harness, at, when);
			const resumed = await resume(harness, lines);

			expect({ at, when, reason: resumed.reason }).toEqual({ at, when, reason: "done" });
			const after = await harness.inner.read();
			expect(after.ok).toBe(true);
			expect({
				at,
				when,
				record: projection(entriesOf(after.ok ? after.value : [])),
			}).toEqual({ at, when, record: expected });
		}
	}
});

test("RSM02 an unsafe call killed anywhere runs at most once and is reported as unknown", async () => {
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "write", args: { line: "hello" } }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];

	// Every kill point of a two-turn run, so the tool is cut before it starts, while it
	// runs, and after it has changed something.
	for (let at = 2; at <= 8; at += 1) {
		for (const when of ["before", "after"] as const) {
			const executions: Executions = executionCounter();
			const harness = crashHarness(turns, () => [
				toolReturning("write", "wrote one line", { executions }),
				safeFinish(),
			]);
			const lines = await dieAt(harness, at, when);
			const resumed = await resume(harness, lines);

			// Whatever the kill point, the call ran at most once in total: the record
			// cannot say whether it started, so it is never repeated.
			expect(executions.count("c1")).toBeLessThanOrEqual(1);
			expect(resumed.reason).toBe("done");

			// If the kill landed before the result was saved, the model is told the
			// outcome is unknown instead of being given an answer nobody has.
			// The call was cut only if its assistant turn was saved and its result was
			// not: before that the resume makes the call for the first time, and after
			// it the answer is in the record.
			const cut = (at === 4 && when === "after") || (at === 5 && when === "before");
			const saved = !cut && at >= 5;
			const after = await harness.inner.read();
			expect(after.ok).toBe(true);
			const first = entriesOf(after.ok ? after.value : []).find(
				(entry) => entry.type === "tool_message",
			);
			if (cut && first?.type === "tool_message") {
				expect(first.content).toMatch(/outcome unknown/);
			}
			if (saved && first?.type === "tool_message") {
				expect(first.content).toBe("wrote one line");
			}
		}
	}
});

test("RSM04 a broken record fails the resume with a reason and never throws", async () => {
	const harness = crashHarness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
		safeFinish(),
	]);

	const notJson = await resume(harness, ["not json at all"]);
	expect(notJson.reason).toBe("failed");
	expect(notJson.reason === "failed" ? notJson.error?.code : "").toBe("internal");

	const noHeader = await resume(harness, [
		'{"type":"user_message","id":"e1","parent":null,"ts":1,"label":"task","text":"hi"}',
	]);
	expect(noHeader.reason).toBe("failed");
	expect(noHeader.reason === "failed" ? noHeader.error?.code : "").toBe("internal");

	// A damaged tail is not fatal: the loader skips it and the run continues.
	const good = await (async () => {
		const healthy = crashHarness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
			safeFinish(),
		]);
		await runTask({
			...healthy.setup,
			model: scriptedModel([{ toolCalls: [{ id: "c1", name: "finish" }] }], {
				clock: healthy.clock,
			}),
			storage: healthy.inner,
		});
		const read = await healthy.inner.read();
		return { harness: healthy, lines: read.ok ? read.value : [] };
	})();

	// A damaged tail is skipped and noted, never fatal: the accepted finish before it
	// still counts, so the run ends done rather than asking for another turn.
	const damaged = [...good.lines.slice(0, -1), '{"type":"status","id":"e1"'];
	const afterDamage = await resume(good.harness, damaged);
	expect(afterDamage.reason).toBe("done");
});

/** A short script of safe calls ending in a finish, which is what a resume may repeat. */
const resumableScript = fc.array(fc.constantFrom("read", "look"), { maxLength: 3 }).map((names) => [
	...names.map((name, index) => ({
		toolCalls: [{ id: `c${index}`, name, args: {} }],
	})),
	{ toolCalls: [{ id: `c${names.length}`, name: "finish" }] },
]);

test("RSM05 property: killed anywhere, any script, the resume matches the whole run", async () => {
	await fc.assert(
		fc.asyncProperty(resumableScript, async (turns) => {
			const makeTools = (): Tool[] => [readTool("read"), readTool("look"), safeFinish()];

			const whole = crashHarness(turns, makeTools);
			const uninterrupted = await runTask({
				...whole.setup,
				model: scriptedModel(turns, { clock: whole.clock }),
				storage: whole.inner,
			});
			expect(uninterrupted.reason).toBe("done");
			const readWhole = await whole.inner.read();
			expect(readWhole.ok).toBe(true);
			const wholeLines = readWhole.ok ? readWhole.value : [];
			const conversation = JSON.stringify(replayConversation(entriesOf(wholeLines)));

			for (let at = 2; at <= wholeLines.length; at += 1) {
				for (const when of ["before", "after"] as const) {
					const harness = crashHarness(turns, makeTools);
					const lines = await dieAt(harness, at, when);

					const events: string[] = [];
					const handle = await resume(harness, lines, (event) => {
						events.push(event.type);
					});
					expect({ at, when, reason: handle.reason }).toEqual({
						at,
						when,
						reason: "done",
					});

					const read = await harness.inner.read();
					expect(read.ok).toBe(true);
					const after = read.ok ? read.value : [];
					// The record still loads, and the conversation the model would see is
					// the one the uninterrupted run ended with.
					const loaded = loadRecord(after);
					expect(loaded.ok).toBe(true);
					expect(JSON.stringify(replayConversation(entriesOf(after)))).toBe(conversation);

					// Each segment that ends says so exactly once.
					expect(events.filter((type) => type === "run_end")).toHaveLength(1);
					expect(events.at(-1)).toBe("run_end");
				}
			}
		}),
		{ numRuns: 15 },
	);
});

test("RSM01 a follow-up saved after an accepted finish is not skipped by a resume", async () => {
	const turns: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "finish" }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];
	const clock = fakeClock();
	const inner = memoryStorage();
	// The kill lands on the assistant turn the follow-up caused, so the record ends
	// with an accepted finish and then a message that means the run must go on.
	const dying = crashingStorage(inner, { at: 7, when: "before" });
	const handle = createRun({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [safeFinish()],
		model: scriptedModel(turns, { clock }),
		storage: dying,
		clock,
		ids: counterIds(),
	});
	expect(handle.followUp("one more thing")).toMatchObject({ ok: true });
	await until(() => dying.appends() >= 7);

	const read = await inner.read();
	expect(read.ok).toBe(true);
	const model = scriptedModel(turns, { clock });
	const resumed = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [safeFinish()],
		model,
		storage: inner,
		clock,
		ids: counterIds(),
		resume: { lines: read.ok ? read.value : [], by: "person" },
	});

	expect(resumed.reason).toBe("done");
	// The model was asked for the turn the follow-up deserves, rather than the run
	// ending on the finish that came before it.
	expect(model.requests).toHaveLength(1);
});
