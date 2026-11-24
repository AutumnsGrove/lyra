/**
 * The runtime: the runs this process is driving (docs/limits-and-interruptions.md,
 * RSM03, RSM04 and RSM06; decisions 12, 20 and 23).
 *
 * One registry, because "does anything own this run right now" is the question that
 * makes a late, duplicate or concurrent wake harmless. A run this process is driving
 * is in `runs`; a resume that is still reading the record is in flight; anything else
 * is the record's business, and `resume` and `wake` differ only in who is asking:
 *
 * - a wake may continue a run that was `running` when its host died, and must leave
 *   every parked run alone (decision 23);
 * - a person may continue anything.
 *
 * The runtime does not schedule wakes. The host's Waking slot does that, and passes
 * the alarm back to `wake`, so the same run is never driven twice.
 */

import type { Recipe } from "./define-recipe.js";
import type { JsonValue } from "./json.js";
import {
	SchemaDefinitionError,
	compileSchema,
	formatErrors,
	validateValue,
	type CompiledSchema,
	type Validation,
} from "./schema.js";
import type { LoadedRecord } from "../record/load.js";
import { loadRecord } from "../record/load.js";
import { activePath } from "../record/replay.js";
import type { Clock, Ids } from "./clock.js";
import type { Limits } from "./limits.js";
import type { ModelSlot } from "./model.js";
import { fail, ok, type Result } from "./result.js";
import type { RunConfig, StuckSettings } from "./run.js";
import { createRun, type RunHandle, type RunSetup } from "./run-handle.js";
import type { StorageSlot, WakingSlot } from "./slots.js";
import type { Tool } from "./tool.js";

/**
 * The recipe a runtime runs. Step 2's minimal shape is this with `input` and
 * `setup` absent, which is a plain run that takes a text input (decision 5).
 */
export type RunDefinition = Recipe;

export interface RuntimeOptions {
	storage: StorageSlot;
	clock: Clock;
	ids: Ids;
	model: ModelSlot;
	/** The model the recipe names, when it names one. */
	modelName?: string;
	host: string;
	/** Whose session this runtime serves, written on every record it starts. */
	tenant?: string;
	/**
	 * Whether a person can be reached to answer a request (decision 35). A session
	 * sets it, because a session is where a person is; a bare runtime leaves it off.
	 */
	canAsk?: boolean;
	/**
	 * How a host wakes a run whose process died. The runtime schedules one ahead as
	 * each step begins, re-arms it, and cancels it when the run ends, so an accident
	 * resumes on its own (decisions 12, 23).
	 */
	waking?: WakingSlot;
	/** How far ahead a wake is set, in milliseconds. Sixty seconds by default. */
	wakeAfterMs?: number;
}

export interface StartRequest {
	runId: string;
	task: string;
	/** The task's input, checked against the recipe's own schema before a run begins. */
	input: JsonValue;
	definition: RunDefinition;
}

export interface ResumeRequest {
	runId: string;
	task: string;
	/** The recipe as it is now, which is what a resume is checked against. */
	definition: RunDefinition;
	/** Who is asking. A wake may only continue an accident (decision 23). */
	by?: "wake" | "person";
	/** New limits for a resumed run, which is how a park is lifted (decision 22). */
	limits?: Limits;
	/**
	 * A message a person adds while continuing a record that has ended (decision 44).
	 * A wake never carries one: an accident has nothing new to say.
	 */
	followUp?: string;
}

/** Checks a value against a recipe's input schema, once the schema is compiled. */
export type InputCheck = (value: JsonValue) => Validation<JsonValue>;

/**
 * Compile a definition's input schema once, and hand back the check that uses it.
 * A hand-written `RunDefinition` can carry a schema this build cannot compile, and
 * that is a `bad_request` rather than a throw, because the caller only sees a
 * `Result` (found in review, step 3).
 */
function inputCheckOf(definition: RunDefinition): Result<InputCheck | undefined> {
	if (definition.input === undefined) {
		return ok(undefined);
	}
	let compiled: CompiledSchema;
	try {
		compiled = compileSchema(definition.input, "input");
	} catch (error) {
		const message = error instanceof SchemaDefinitionError ? error.message : String(error);
		return fail("bad_request", `the recipe's input schema cannot be checked: ${message}`);
	}
	return ok((value) => validateValue(compiled, value, "input"));
}

export interface Runtime {
	/**
	 * Begin a run, and hand back the handle a person steers. An input the recipe's
	 * schema refuses is `bad_request`, and nothing is written (RCP05).
	 */
	start(request: StartRequest): Result<RunHandle>;
	/** Continue a run from its record. Refused with `not_found` when there is none. */
	resume(request: ResumeRequest): Promise<Result<RunHandle>>;
	/** The host's alarm, which is a resume that may not overrule a person. */
	wake(request: ResumeRequest): Promise<Result<RunHandle>>;
	/** The handle for a run this process is driving, if it is. */
	active(runId: string): RunHandle | undefined;
}

/** The job text a record already holds, which a resume with no input of its own needs. */
function firstUserText(record: LoadedRecord): string | undefined {
	for (const entry of activePath(record.entries)) {
		if (entry.type === "user_message") {
			return entry.text;
		}
	}
	return undefined;
}

export function createRuntime(options: RuntimeOptions): Runtime {
	const runs = new Map<string, RunHandle>();
	/** Resumes still reading the record, so two calls share one run. */
	const inFlight = new Map<string, Promise<Result<RunHandle>>>();

	const wakeAfterMs = options.wakeAfterMs ?? 60_000;

	/**
	 * Keep one wake scheduled for as long as a run is alive. A step re-arms it, so a
	 * late alarm is always about a run that is still working, and the end cancels it
	 * so a finished run is not woken.
	 */
	const armsWake = (runId: string, handle: RunHandle): void => {
		const waking = options.waking;
		if (waking === undefined) {
			return;
		}
		/** Whether the run's last act was asking a person with a timeout, whose wake must survive the park. */
		let timeoutPending = false;
		handle.subscribe((event) => {
			if (event.type === "turn_start") {
				void waking
					.schedule(runId, options.clock.now() + wakeAfterMs)
					.catch(() => undefined);
			}
			if (event.type === "request" && event.timeoutMs !== undefined) {
				// A request nobody answers is denied when its timeout passes, so the host
				// arranges that wake now and the run keeps costing nothing (decision 37).
				// It is the one wake a park must not cancel, or nothing would fire.
				timeoutPending = true;
				void waking
					.schedule(runId, options.clock.now() + event.timeoutMs)
					.catch(() => undefined);
			}
			if (event.type === "run_end") {
				// A run that ends waiting for a person keeps its alarm: that wake is what
				// denies the request when its timeout passes, and a resume that parks
				// again is a new handle that never saw the request (decision 37).
				const waitingFor =
					event.reason === "parked" && event.parkedReason === "waiting_for_person";
				if (!timeoutPending && !waitingFor) {
					void waking.cancel(runId).catch(() => undefined);
				}
				timeoutPending = false;
			}
		});
	};

	const track = (runId: string, handle: RunHandle): void => {
		runs.set(runId, handle);
		void handle.outcome.finally(() => {
			// The run is over, so the registry no longer owns it: a later wake goes back
			// to the record, where the ending is.
			if (runs.get(runId) === handle) {
				runs.delete(runId);
			}
		});
	};

	/**
	 * What a setup takes from the recipe itself. Both `start` and a resume spread
	 * this, so a field the recipe gains cannot reach one of the two paths and miss
	 * the other; `maxParallelCalls` reached only the resume at first (found in
	 * review).
	 */
	const fromDefinition = (
		definition: RunDefinition,
	): Partial<RunSetup> & Pick<RunSetup, "system" | "tools"> => ({
		system: definition.instructions,
		tools: definition.tools,
		recipe: { name: definition.name, version: definition.version },
		...(definition.setup === undefined ? {} : { setup: definition.setup }),
		...(definition.fallbackModel === undefined
			? {}
			: { fallbackModel: definition.fallbackModel }),
		...(definition.stuck === undefined ? {} : { stuck: definition.stuck }),
		...(definition.compaction === undefined ? {} : { compaction: definition.compaction }),
		...(definition.approvals === undefined ? {} : { approvals: definition.approvals }),
		...(definition.maxParallelCalls === undefined
			? {}
			: { maxParallelCalls: definition.maxParallelCalls }),
	});

	const setupFor = (
		request: ResumeRequest,
		extra: Pick<RunConfig, "input" | "resume">,
		inputCheck: InputCheck | undefined,
	): RunSetup => {
		const definition = request.definition;
		const setup: RunSetup = {
			runId: request.runId,
			task: request.task,
			host: options.host,
			input: extra.input,
			model: options.model,
			storage: options.storage,
			clock: options.clock,
			ids: options.ids,
			...fromDefinition(definition),
			...(inputCheck === undefined ? {} : { inputCheck }),
			...(options.tenant === undefined ? {} : { tenant: options.tenant }),
			...((request.limits ?? definition.limits) === undefined
				? {}
				: { limits: request.limits ?? definition.limits }),
			...(options.canAsk === true ? { canAsk: true } : {}),
			...(options.modelName === undefined ? {} : { modelName: options.modelName }),
			...(extra.resume === undefined ? {} : { resume: extra.resume }),
		};
		return setup;
	};

	const resume = (request: ResumeRequest): Promise<Result<RunHandle>> => {
		const existing = runs.get(request.runId);
		if (existing !== undefined) {
			// Something here is already driving it, so a second wake or resume joins it
			// rather than starting a rival run (RSM03).
			return Promise.resolve(ok(existing));
		}
		const pending = inFlight.get(request.runId);
		if (pending !== undefined) {
			return pending;
		}
		const started = beginResume(request).finally(() => {
			inFlight.delete(request.runId);
		});
		inFlight.set(request.runId, started);
		return started;
	};

	const beginResume = async (request: ResumeRequest): Promise<Result<RunHandle>> => {
		const read = await options.storage.read();
		if (!read.ok) {
			return read;
		}
		if (read.value.length === 0) {
			return fail("not_found", `there is no record for run ${request.runId}`);
		}
		const loaded = loadRecord(read.value);
		// A record with no readable header has no task message to offer, and the run
		// then fails through the same path as any other unusable record.
		const input = loaded.ok ? (firstUserText(loaded.value) ?? "") : "";
		const check = inputCheckOf(request.definition);
		if (!check.ok) {
			return check;
		}
		const handle = createRun(
			setupFor(
				request,
				{
					input,
					resume: {
						lines: read.value,
						by: request.by ?? "person",
						...(request.followUp === undefined ? {} : { followUp: request.followUp }),
					},
				},
				check.value,
			),
		);
		track(request.runId, handle);
		armsWake(request.runId, handle);
		return ok(handle);
	};

	return {
		active: (runId) => runs.get(runId),

		start(request) {
			const definition = request.definition;
			const check = inputCheckOf(definition);
			if (!check.ok) {
				return check;
			}
			if (check.value !== undefined) {
				const checked = check.value(request.input);
				if (!checked.ok) {
					return fail("bad_request", formatErrors(checked.errors, "invalid input"));
				}
			}
			const setup: RunSetup = {
				runId: request.runId,
				task: request.task,
				host: options.host,
				input: definition.setup === undefined ? String(request.input) : "",
				inputValue: request.input,
				model: options.model,
				storage: options.storage,
				clock: options.clock,
				ids: options.ids,
				...fromDefinition(definition),
				...(check.value === undefined ? {} : { inputCheck: check.value }),
				...(options.tenant === undefined ? {} : { tenant: options.tenant }),
				...(definition.limits === undefined ? {} : { limits: definition.limits }),
				...(options.canAsk === true ? { canAsk: true } : {}),
				...(options.modelName === undefined ? {} : { modelName: options.modelName }),
			};
			const handle = createRun(setup);
			track(request.runId, handle);
			armsWake(request.runId, handle);
			return ok(handle);
		},

		resume,

		wake: (request) => resume({ ...request, by: "wake" }),
	};
}
