import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { createFinishTool } from "../../core/finish.js";
import type { RunDefinition } from "../../core/runtime.js";
import { FAKE_CLOCK_START, toolReturning, toolTakingTime } from "../../testkit/index.js";
import type { FixtureRun, FixtureSession } from "./testing/fixture-session.testing.js";
import { alarmWaking } from "./waking.js";

/**
 * CFL07 to CFL13 in `docs/adapters.md`: the alarm, which is the Waking slot on
 * Cloudflare. Every case runs in workerd against the object's real alarm.
 */

type Stub = ReturnType<typeof sessionStub>;

function sessionStub() {
	return env.FIXTURE_SESSION.get(env.FIXTURE_SESSION.newUniqueId());
}

function plainDefinition(clock: Parameters<FixtureRun["definition"]>[0]): RunDefinition {
	return {
		name: "fixture",
		version: 1,
		instructions: "do the thing",
		tools: [
			toolTakingTime("slow", 10_000, clock),
			toolReturning("read", "the content"),
			createFinishTool({ check: () => ({ ok: true }) }),
		],
	};
}

async function configured(run: Partial<FixtureRun> = {}): Promise<Stub> {
	const stub = sessionStub();
	const full: FixtureRun = {
		definition: plainDefinition,
		input: "go",
		turns: [{ toolCalls: [{ id: "c1", name: "finish", args: {} }] }],
		...run,
	};
	await runInDurableObject(stub, (instance: FixtureSession) => {
		instance.configure(full);
	});
	return stub;
}

/** Let the run reach the point where it has scheduled its step's wake. */
async function untilWake(stub: Stub): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		const scheduled = await runInDurableObject(stub, (instance: FixtureSession) =>
			instance.scheduled(),
		);
		if (scheduled !== undefined) {
			return;
		}
	}
	throw new Error("the run never scheduled a wake");
}

function statuses(lines: readonly string[]): string[] {
	return lines
		.map((line) => JSON.parse(line) as { type?: unknown; state?: unknown })
		.filter((entry) => entry.type === "status")
		.map((entry) => String(entry.state));
}

test("CFL07 a scheduled wake fires the handler once", async () => {
	const stub = await configured();
	await runInDurableObject(stub, async (_instance: FixtureSession, state: DurableObjectState) => {
		await alarmWaking(state.storage).schedule("run-1", FAKE_CLOCK_START + 1_000);
	});

	expect(await runDurableObjectAlarm(stub)).toBe(true);
	await runInDurableObject(stub, (instance: FixtureSession) => {
		expect(instance.alarmCount).toBe(1);
	});
});

test("CFL08 a second schedule replaces the first, with one alarm", async () => {
	const stub = await configured();
	await runInDurableObject(stub, async (instance: FixtureSession, state: DurableObjectState) => {
		const waking = alarmWaking(state.storage);
		// A time in the future, because Miniflare fires a past alarm at once and its
		// `getAlarm()` then reports when it will actually run.
		const first = Date.now() + 60_000;
		const second = Date.now() + 120_000;
		await waking.schedule("run-1", first);
		await waking.schedule("run-1", second);
		expect(await instance.scheduled()).toEqual({ runId: "run-1", atMs: second });
		expect(await state.storage.getAlarm()).toBe(second);
	});
});

test("CFL09 a cancelled wake does not fire", async () => {
	const stub = await configured();
	await runInDurableObject(stub, async (_instance: FixtureSession, state: DurableObjectState) => {
		const waking = alarmWaking(state.storage);
		await waking.schedule("run-1", FAKE_CLOCK_START + 1_000);
		await waking.cancel("run-1");
		expect(await state.storage.getAlarm()).toBeNull();
	});

	expect(await runDurableObjectAlarm(stub)).toBe(false);
});

test("CFL10 an alarm after the run finished has nothing to do", async () => {
	const stub = await configured();
	await runInDurableObject(stub, (instance: FixtureSession) => instance.start());
	const outcome = await runInDurableObject(stub, (instance: FixtureSession) =>
		instance.outcome(),
	);
	expect(outcome.reason).toBe("done");

	// The runtime cancelled the wake when the run ended, so no alarm is left.
	expect(await runDurableObjectAlarm(stub)).toBe(false);
	const lines = await runInDurableObject(stub, (instance: FixtureSession) => instance.lines());
	expect(statuses(lines)).toEqual(["running", "done"]);
});

test("CFL11 an alarm delivered twice resumes the run once", async () => {
	const run = {
		turns: [
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
	};
	const stub = await configured(run);
	await runInDurableObject(stub, (instance: FixtureSession) => instance.start());
	await untilWake(stub);
	await evictDurableObject(stub);

	// A fresh instance, as a deploy leaves one, with the same recipe and code.
	await runInDurableObject(stub, (instance: FixtureSession) =>
		instance.configure({
			definition: plainDefinition,
			input: "go",
			...run,
		}),
	);
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	// The alarm is delivered again; the runtime's registry joins the run.
	await runInDurableObject(stub, (instance: FixtureSession) => instance.alarm());

	const outcome = await runInDurableObject(stub, (instance: FixtureSession) =>
		instance.outcome(),
	);
	expect(outcome.reason).toBe("done");
	const lines = await runInDurableObject(stub, (instance: FixtureSession) => instance.lines());
	expect(statuses(lines)).toEqual(["running", "resumed", "done"]);
});

test("CFL12 an alarm while the run is live does not start a second loop", async () => {
	const stub = await configured({
		turns: [
			{ toolCalls: [{ id: "c1", name: "read", args: {} }], delayMs: 10_000 },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
	});
	await runInDurableObject(stub, (instance: FixtureSession) => instance.start());
	await untilWake(stub);

	// The run has an alarm set a step ahead; firing it now finds the run in the
	// registry and joins it rather than starting a rival.
	expect(await runDurableObjectAlarm(stub)).toBe(true);
	await runInDurableObject(stub, (instance: FixtureSession) => instance.advance(10_000));

	const outcome = await runInDurableObject(stub, (instance: FixtureSession) =>
		instance.outcome(),
	);
	expect(outcome.reason).toBe("done");
	const lines = await runInDurableObject(stub, (instance: FixtureSession) => instance.lines());
	expect(statuses(lines)).toEqual(["running", "done"]);
});

test("CFL13 the handler never throws, even when the record cannot be read", async () => {
	const stub = await configured();
	await runInDurableObject(stub, async (_instance: FixtureSession, state: DurableObjectState) => {
		// A record that is not a record: the loader refuses it, the resume fails the
		// run, and the handler still returns rather than asking to be retried forever.
		state.storage.sql.exec(
			"CREATE TABLE IF NOT EXISTS lyra_entries (seq INTEGER PRIMARY KEY, line TEXT NOT NULL)",
		);
		state.storage.sql.exec("INSERT INTO lyra_entries (seq, line) VALUES (0, 'not a record')");
		// Due now: `runDurableObjectAlarm` only runs an alarm whose time has come.
		await alarmWaking(state.storage).schedule("run-1", Date.now() - 1_000);
	});
	// A wake is what the runtime set for a run that was live; the record is damaged.
	// The handler is called directly, which is how a workerd test reaches one
	// (decision 101: `import()` inside the handler does not work, and the plugin's
	// alarm helper only runs an alarm whose time has come).
	const threw = await runInDurableObject(stub, async (instance: FixtureSession) => {
		try {
			await instance.alarm();
			return false;
		} catch {
			return true;
		}
	});
	expect(threw).toBe(false);
	// The handler starts the resume and returns; the run's own end is what must be
	// waited for before the record is read.
	const outcome = await runInDurableObject(stub, (instance: FixtureSession) =>
		instance.outcome(),
	);
	expect(outcome.reason).toBe("failed");
	// A record with no header is not a record, so the run fails without writing into
	// it: the handler's success is that it returned and the run ended.
	const lines = await runInDurableObject(stub, (instance: FixtureSession) => instance.lines());
	expect(lines).toEqual(["not a record"]);
});
