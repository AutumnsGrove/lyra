/**
 * The fixture Durable Object (docs/implementation/04-cloudflare-adapter.md).
 *
 * A test double for the step 6 session object: it builds a runtime over this
 * adapter, with the testkit's fake clock, ids and scripted model, and exposes just
 * enough for a test to configure a run, start it, look at what was saved, and fire
 * the alarm. It is test support, so it is named `.testing.ts` and none of it
 * ships.
 *
 * A kill test works by configuring the object, starting a run, and letting the fake
 * clock or a frozen append hold it in place; the test then evicts the object, and a
 * fresh instance is configured the same way before its alarm fires. That is the
 * shape a deploy has: the code (including the recipe) comes back, and only the
 * record is carried over.
 */

import type { JsonValue } from "../../../core/json.js";
import type { RunHandle } from "../../../core/run-handle.js";
import type { RunResult } from "../../../core/run.js";
import { createRuntime, type RunDefinition, type Runtime } from "../../../core/runtime.js";
import type { StorageSlot } from "../../../core/slots.js";
import { counterIds } from "../../memory/index.js";
import {
	crashingStorage,
	failingStorage,
	fakeClock,
	scriptedModel,
	type FakeClock,
	type ScriptedModel,
	type ScriptedTurn,
} from "../../../testkit/index.js";
import { alarmWaking, durableObjectStorage, scheduledWake, type ScheduledWake } from "../index.js";

export interface FixtureRun {
	/**
	 * The recipe as the host's code provides it. It is a factory because some tools
	 * wait on the runtime's own clock, which only exists once the instance is built.
	 */
	definition: (clock: FakeClock) => RunDefinition;
	input: JsonValue;
	turns: ScriptedTurn[];
	runId?: string;
	/** Freeze this instance's nth append (from one), to hold the run at that point. */
	faultAt?: number;
	/** Whether a frozen append happens before or after the line lands. */
	faultWhen?: "before" | "after";
	/** Make this instance's nth append fail instead, as a broken storage would. */
	failAt?: number;
}

export class FixtureSession {
	/** How many times the alarm handler has run, for CFL07 and CFL11. */
	alarmCount = 0;

	#run: FixtureRun | undefined;
	#definition: RunDefinition | undefined;
	#clock: FakeClock | undefined;
	#model: ScriptedModel | undefined;
	#runtime: Runtime | undefined;
	#storage: StorageSlot | undefined;
	#appends = 0;
	#handle: RunHandle | undefined;
	#woken: RunHandle | undefined;

	constructor(readonly state: DurableObjectState) {}

	/** The run the next start or alarm is for, as a deploy would hand the object. */
	configure(run: FixtureRun): void {
		this.#run = run;
		this.#definition = undefined;
		this.#clock = undefined;
		this.#model = undefined;
		this.#runtime = undefined;
		this.#storage = undefined;
		this.#appends = 0;
		this.#handle = undefined;
		this.#woken = undefined;
	}

	#storageSlot(): StorageSlot {
		const existing = this.#storage;
		if (existing !== undefined) {
			return existing;
		}
		const adapter = durableObjectStorage(this.state.storage);
		const run = this.#run;
		const guarded =
			run?.failAt !== undefined
				? failingStorage(adapter, { failOn: run.failAt })
				: run?.faultAt !== undefined
					? crashingStorage(adapter, { at: run.faultAt, when: run.faultWhen ?? "before" })
					: adapter;
		// Counting sits outside the fault wrapper, so an attempt that freezes before it
		// reaches storage still counts: that is the append the test is waiting for.
		this.#storage = {
			...(adapter.maxEntryBytes === undefined
				? {}
				: { maxEntryBytes: adapter.maxEntryBytes }),
			append: (line) => {
				this.#appends += 1;
				return guarded.append(line);
			},
			read: () => guarded.read(),
		};
		return this.#storage;
	}

	#build(): Runtime {
		const existing = this.#runtime;
		if (existing !== undefined) {
			return existing;
		}
		const run = this.#run;
		if (run === undefined) {
			throw new Error("the fixture has no run configured");
		}
		const clock = fakeClock();
		const definition = run.definition(clock);
		const model = scriptedModel(run.turns, { clock });
		const runtime = createRuntime({
			storage: this.#storageSlot(),
			clock,
			ids: counterIds(),
			model,
			host: "fixture",
			waking: alarmWaking(this.state.storage),
		});
		this.#clock = clock;
		this.#model = model;
		this.#definition = definition;
		this.#runtime = runtime;
		return runtime;
	}

	/** Begin the configured run and return at once, so a test can pull the object out from under it. */
	start(): void {
		const run = this.#run;
		if (run === undefined) {
			throw new Error("the fixture has no run configured");
		}
		const runtime = this.#build();
		const definition = this.#definition;
		if (definition === undefined) {
			throw new Error("the fixture has no definition");
		}
		const started = runtime.start({
			runId: run.runId ?? "run-1",
			task: definition.name,
			input: run.input,
			definition,
		});
		if (!started.ok) {
			throw new Error(started.error.message);
		}
		this.#handle = started.value;
	}

	/** The ends of the run this instance started, or of the one an alarm woke. */
	async outcome(): Promise<RunResult> {
		const handle = this.#woken ?? this.#handle;
		if (handle === undefined) {
			throw new Error("no run has started here");
		}
		return handle.outcome;
	}

	/** Move the fake clock, which is how a held run is let go. */
	advance(ms: number): void {
		this.#clock?.advance(ms);
	}

	/** The record, read through the storage adapter. */
	async lines(): Promise<string[]> {
		const read = await durableObjectStorage(this.state.storage).read();
		if (!read.ok) {
			throw new Error(read.error.message);
		}
		return read.value;
	}

	/** What this object holds as its wake, for the waking rows. */
	scheduled(): Promise<ScheduledWake | undefined> {
		return scheduledWake(this.state.storage);
	}

	/** How many model requests this instance made. */
	requests(): number {
		return this.#model?.requests.length ?? 0;
	}

	/** How many appends this instance attempted, for a kill held on a frozen one. */
	appends(): number {
		return this.#appends;
	}

	/** The object's own alarm handler, as a host would write it. */
	async alarm(): Promise<void> {
		this.alarmCount += 1;
		try {
			const wake = await scheduledWake(this.state.storage);
			if (wake === undefined || this.#run === undefined) {
				return;
			}
			const runtime = this.#build();
			const definition = this.#definition;
			if (definition === undefined) {
				return;
			}
			const woken = await runtime.wake({
				runId: wake.runId,
				task: definition.name,
				definition,
			});
			if (woken.ok) {
				this.#woken = woken.value;
			}
		} catch {
			// An alarm is retried when its handler throws, so a domain failure is
			// recorded nowhere it can be read and the handler returns.
		}
	}

	async fetch(request: Request): Promise<Response> {
		const path = new URL(request.url).pathname;
		if (path === "/probe") {
			return new Response("fixture session");
		}
		const pings = (await this.state.storage.get<number>("pings")) ?? 0;
		await this.state.storage.put("pings", pings + 1);
		return new Response(`fixture session ${pings + 1}`);
	}
}
