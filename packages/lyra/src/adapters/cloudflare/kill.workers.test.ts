import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { createFinishTool } from "../../core/finish.js";
import type { RecordEntry } from "../../record/entries.js";
import { loadRecord } from "../../record/load.js";
import type { RunResult } from "../../core/run.js";
import type { RunDefinition } from "../../core/runtime.js";
import {
	executionCounter,
	renderHandles,
	renderPage,
	timelineTestRecipe,
	toolReturning,
	toolTakingTime,
	type FakeClock,
	type ScriptedTurn,
	type TimelineState,
} from "../../testkit/index.js";
import { alarmWaking } from "./waking.js";
import type { FixtureRun, FixtureSession } from "./testing/fixture-session.testing.js";

/**
 * CFL14 to CFL18 in `docs/adapters.md`: the step's reason for existing.
 *
 * A run is held (on the fake clock, or by freezing one append), the object is
 * evicted, a fresh instance is configured as a deploy would leave one, and its
 * alarm resumes the record. What makes this real rather than simulated is that
 * workerd drops the instance's memory when it is evicted: only the record in
 * SQLite survives.
 */

type Stub = ReturnType<typeof sessionStub>;

function sessionStub() {
	return env.FIXTURE_SESSION.get(env.FIXTURE_SESSION.newUniqueId());
}

async function configure(stub: Stub, run: FixtureRun): Promise<void> {
	await runInDurableObject(stub, (instance: FixtureSession) => instance.configure(run));
}

async function start(stub: Stub): Promise<void> {
	await runInDurableObject(stub, (instance: FixtureSession) => instance.start());
}

async function outcomeOf(stub: Stub): Promise<RunResult> {
	return runInDurableObject(stub, (instance: FixtureSession) => instance.outcome());
}

async function linesOf(stub: Stub): Promise<string[]> {
	return runInDurableObject(stub, (instance: FixtureSession) => instance.lines());
}

async function appendsOf(stub: Stub): Promise<number> {
	return runInDurableObject(stub, (instance: FixtureSession) => instance.appends());
}

/** Let the run reach an append, without waiting on the fake clock. */
async function settle(stub: Stub, at: number): Promise<void> {
	let last = -1;
	for (let attempt = 0; attempt < 50; attempt += 1) {
		last = await appendsOf(stub);
		if (last >= at) {
			return;
		}
	}
	throw new Error(`the run never reached append ${at} (last ${last})`);
}

/** Take the object away, bring a fresh one back with the same code, and fire its alarm. */
async function killAndWake(stub: Stub, run: FixtureRun): Promise<void> {
	await evictDurableObject(stub);
	await configure(stub, run);
	let fired = await runDurableObjectAlarm(stub);
	if (!fired) {
		// A kill before the first step began left no wake. A host's alarm at the
		// record's own time is what would bring such a run back, so the test sets one.
		await runInDurableObject(
			stub,
			async (_instance: FixtureSession, state: DurableObjectState) => {
				await alarmWaking(state.storage).schedule(run.runId ?? "run-1", Date.now() - 1_000);
				await state.storage.setAlarm(Date.now() - 1_000);
			},
		);
		fired = await runDurableObjectAlarm(stub);
	}
	expect(fired).toBe(true);
}

/** A record reduced to what a caller can see, minus the differences a resume may make. */
function projection(lines: readonly string[]): string[] {
	const loaded = loadRecord([...lines]);
	if (!loaded.ok) {
		throw new Error(`the record did not load: ${loaded.error.message}`);
	}
	const out: string[] = [];
	for (const entry of loaded.value.entries) {
		out.push(...projected(entry));
	}
	return out;
}

function projected(entry: RecordEntry): string[] {
	switch (entry.type) {
		case "status":
			// Progress, not content: a resume writes `resumed` where the run would
			// have gone on, and where the kill landed changes which statuses exist.
			return [];
		case "user_message":
			return [`user ${entry.label} ${entry.text}`];
		case "assistant_message":
			return [
				`assistant ${entry.text} ${entry.toolCalls
					.map((call) => `${call.id}/${call.name}/${call.arguments}`)
					.join(",")} ${entry.finishReason} ${entry.retries ?? 0}`,
			];
		case "tool_message":
			if (entry.content.startsWith("outcome unknown:")) {
				return [];
			}
			return [
				`tool ${entry.toolCallId} ${entry.isError} ${entry.content} ${entry.done === true}`,
			];
		default:
			return [entry.type];
	}
}

const DAY = {
	repos: ["lattice", "lyra"],
	commits: [
		{ repo: "lattice", sha: "abc123", message: "Fix the thing" },
		{ repo: "lyra", sha: "def456", message: "Write the docs" },
	],
};

const PAGE_TURNS: ScriptedTurn[] = [
	{ toolCalls: [{ id: "t1", name: "start_project", args: { repo: "lattice" } }] },
	{
		toolCalls: [
			{
				id: "t2",
				name: "add_line",
				args: { project: "lattice", text: "Fixed the thing", cites: ["c1"] },
			},
		],
	},
	{ toolCalls: [{ id: "t3", name: "start_project", args: { repo: "lyra" } }] },
	{
		toolCalls: [
			{
				id: "t4",
				name: "add_line",
				args: { project: "lyra", text: "Wrote the docs", cites: ["c2"] },
			},
		],
	},
	{
		toolCalls: [
			{ id: "t5", name: "add_vine", args: { line: "l1", text: "finally, the loop works" } },
		],
	},
	{ toolCalls: [{ id: "t6", name: "finish", args: {} }] },
];

function pageRun(extras: Partial<FixtureRun> = {}): FixtureRun {
	return {
		definition: () => timelineTestRecipe,
		input: DAY,
		turns: PAGE_TURNS,
		...extras,
	};
}

/** The uninterrupted page run, which every killed one is compared with. */
async function wholePage() {
	const stub = sessionStub();
	await configure(stub, pageRun());
	await start(stub);
	const outcome = await outcomeOf(stub);
	const lines = await linesOf(stub);
	const state = outcome.state as TimelineState;
	return {
		outcome,
		lines,
		page: renderPage(state),
		handles: renderHandles(state),
		appends: await appendsOf(stub),
	};
}

test("CFL14 a run held mid-flight, evicted and woken, resumes and ends done", async () => {
	const executions = executionCounter();
	const run: FixtureRun = {
		definition: (clock: FakeClock): RunDefinition => ({
			name: "held",
			version: 1,
			instructions: "do the thing",
			tools: [
				toolTakingTime("slow", 10_000, clock, { executions }),
				createFinishTool({ check: () => ({ ok: true }) }),
			],
		}),
		input: "go",
		turns: [
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
	};
	const stub = sessionStub();
	await configure(stub, run);
	await start(stub);
	// The assistant turn is saved and the tool is waiting on the fake clock; there is
	// no advance, so the run is held exactly where the kill should land.
	await settle(stub, 4);

	await evictDurableObject(stub);
	await configure(stub, run);
	expect(await runDurableObjectAlarm(stub)).toBe(true);

	const outcome = await outcomeOf(stub);
	expect(outcome.reason).toBe("done");
	expect(executions.count("c1")).toBe(1);
	// The call was cut off mid-tool, so the model is told its outcome is unknown.
	const lines = await linesOf(stub);
	expect(lines.some((line) => line.includes("outcome unknown"))).toBe(true);
});

test("CFL03 a run whose storage fails at an append ends failed once", async () => {
	const run = pageRun({ failAt: 5 });
	const stub = sessionStub();
	await configure(stub, run);
	await start(stub);

	const outcome = await outcomeOf(stub);
	expect(outcome.reason).toBe("failed");
	expect(outcome.error?.code).toBe("internal");
	const lines = await linesOf(stub);
	// The failed append saved nothing, and the closing status is the only failure.
	expect(lines.filter((line) => line.includes('"state":"failed"')).length).toBe(1);
	expect(lines.filter((line) => line.includes('"state":"done"')).length).toBe(0);
});

test("CFL15 killed at every append from the first reply on, the run resumes and ends done", async () => {
	const whole = await wholePage();
	expect(whole.outcome.reason).toBe("done");

	for (let at = 4; at <= whole.appends; at += 1) {
		for (const when of ["before", "after"] as const) {
			const stub = sessionStub();
			await configure(stub, pageRun({ faultAt: at, faultWhen: when }));
			await start(stub);
			await settle(stub, at);
			await killAndWake(stub, pageRun());

			const outcome = await outcomeOf(stub);
			expect({ at, when, reason: outcome.reason }).toEqual({ at, when, reason: "done" });
		}
	}
});

test("CFL16 an unsafe tool in flight at eviction is never run twice", async () => {
	const executions = executionCounter();
	const run: FixtureRun = {
		definition: (): RunDefinition => ({
			name: "unsafe",
			version: 1,
			instructions: "do the thing",
			tools: [
				toolReturning("write", "wrote it", { executions }),
				createFinishTool({ check: () => ({ ok: true }) }),
			],
		}),
		input: "go",
		turns: [
			{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
	};
	const stub = sessionStub();
	// Frozen on the result's own append: the tool has run, the result is not saved,
	// and a resume cannot tell whether it did. It must not run it again.
	await configure(stub, { ...run, faultAt: 5, faultWhen: "before" });
	await start(stub);
	await settle(stub, 5);
	await killAndWake(stub, run);

	const outcome = await outcomeOf(stub);
	expect(outcome.reason).toBe("done");
	expect(executions.count("c1")).toBe(1);
	const lines = await linesOf(stub);
	expect(
		lines.some((line) => line.includes("outcome unknown: this call may or may not have run")),
	).toBe(true);
});

test("CFL17 a resumed record carries the same calls and results as the uninterrupted one", async () => {
	const whole = await wholePage();
	const expected = projection(whole.lines);

	for (const at of [4, 6, 9, 12, 14]) {
		const stub = sessionStub();
		await configure(stub, pageRun({ faultAt: at, faultWhen: "before" }));
		await start(stub);
		await settle(stub, at);
		await killAndWake(stub, pageRun());

		const outcome = await outcomeOf(stub);
		expect(outcome.reason).toBe("done");
		expect({ at, record: projection(await linesOf(stub)) }).toEqual({
			at,
			record: expected,
		});
	}
});

test("CFL18 a killed timeline run rebuilds the same page and handles", async () => {
	const whole = await wholePage();

	for (const [at, when] of [
		[5, "before"],
		[7, "after"],
		[9, "before"],
		[12, "after"],
		[14, "before"],
	] as const) {
		const stub = sessionStub();
		await configure(stub, pageRun({ faultAt: at, faultWhen: when }));
		await start(stub);
		await settle(stub, at);
		await killAndWake(stub, pageRun());

		const outcome = await outcomeOf(stub);
		expect(outcome.reason).toBe("done");
		const state = outcome.state as TimelineState;
		expect({ at, when, page: renderPage(state) }).toEqual({
			at,
			when,
			page: whole.page,
		});
		expect({ at, when, handles: renderHandles(state) }).toEqual({
			at,
			when,
			handles: whole.handles,
		});
	}
});
