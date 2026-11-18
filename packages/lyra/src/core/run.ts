/**
 * The loop (docs/core-loop.md, "The loop").
 *
 * Ask the model what to do, run what it asked for, hand the results back, repeat
 * until a tool accepts `finish` (decision 25). A run ends in exactly one of three
 * ways — `done`, `parked` with a reason, or `failed` — and it writes its record as
 * it goes: the assistant message is saved before any of its tools run, and each
 * result right after its tool finishes, so an interruption never loses a step
 * (decision 20).
 *
 * Every step is written before it happens. That is why an exception anywhere ends
 * the run once, with `failed`, and `run_end` is still emitted: the record says how
 * far it got, and a client that was watching is not left waiting.
 */

import type { Clock, Ids } from "./clock.js";
import type { ConversationMessage } from "./conversation.js";
import { executeTools } from "./execute-tools.js";
import type { RunEventListener, RunEndReason, ParkedReason, RunEvent } from "./events.js";
import { reachedLimit, validateLimits, type Limits } from "./limits.js";
import { compareTools, describeChange, pinRecipe } from "./recipe.js";
import type { JsonValue } from "./json.js";
import { formatErrors, type Validation } from "./schema.js";
import { readResumeSeed, reserveIds, type ResumeSeed } from "./resume.js";
import { replayState } from "./state.js";
import type { ModelError, ModelReply, ModelRequest, ModelSlot, ToolCall, Usage } from "./model.js";
import type { LyraError } from "./result.js";
import type { StorageSlot } from "./slots.js";
import type { Tool, ToolOutcome } from "./tool.js";
import { fitEntry, utf8Length } from "../record/truncate.js";
import {
	RECORD_VERSION,
	encodeEntry,
	encodeHeader,
	type AssistantMessageEntry,
	type FallbackEntry,
	type NoteEntry,
	type RecipeStamp,
	type RecipeUpdatedEntry,
	type RecordHeader,
	type RecordEntry,
	type StatusEntry,
	type ToolMessageEntry,
	type UserMessageEntry,
} from "../record/entries.js";

/** Five minutes, per docs/implementation/01-core-with-fakes.md, "Judgment calls already made". */
export const DEFAULT_TOOL_DEADLINE_MS = 300_000;

/** One record entry is capped at 1 MiB (decision 90), because a row is 2 MB. */
export const DEFAULT_ENTRY_CAP_BYTES = 1_048_576;

/** Three retries with growing delays, per decision 26; a healthy run never waits. */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 4_000, 16_000];

/** The cap an entry has: the record's own, lowered to the storage's when that is smaller. */
export function entryCapBytes(storage: StorageSlot, requested?: number): number {
	const own = requested ?? DEFAULT_ENTRY_CAP_BYTES;
	return storage.maxEntryBytes === undefined ? own : Math.min(own, storage.maxEntryBytes);
}

/**
 * A steer or follow-up that is waiting to be written (decisions 19, 27). Its id and
 * time are decided when it is queued, so its owner can check that the entry will
 * fit before it promises to send it.
 */
export interface QueuedMessage {
	id: string;
	ts: number;
	text: string;
}

/**
 * What a run's owner may tell it while it runs. Both texts are read at the moments
 * that keep the record paired, never on arrival: a steer at the gap before the next
 * request, a follow-up when the run would otherwise end.
 */
export interface RunControl {
	takeSteers(): QueuedMessage[];
	takeFollowUps(): QueuedMessage[];
}

/**
 * The stuck safeguard (decision 25). It is on by default because a recipe has no
 * limits unless it asks for them, and a loop that cannot make progress would spend
 * a person's own key forever. `reminders` is how many nudges a model that stops
 * without finishing gets; `sameFailure` is how many identical tool failures in a
 * row stop the run.
 */
export interface StuckSettings {
	enabled?: boolean;
	reminders?: number;
	sameFailure?: number;
}

/** What a model that stopped without finishing is told, at most `reminders` times. */
const REMINDER_TEXT =
	"You have not called a tool and you have not finished. If the job is done, call finish; otherwise continue with the next tool call.";

/**
 * What a recipe's `setup` makes: the first message the model sees, and the state the
 * run starts with. On a resume the same function runs again and the saved results
 * are replayed through each tool's `apply` (decision 112).
 */
export interface TaskStart {
	message: string;
	state: unknown;
}

export interface RunConfig {
	runId: string;
	task: string;
	host: string;
	/** What the person asked for, saved as the first message when no recipe sets it. */
	input: string;
	/** The recipe's input as JSON, saved on the task message so a resume can rebuild. */
	inputValue?: JsonValue;
	/** The recipe's `setup`, when the run has one. */
	setup?: (input: JsonValue) => TaskStart;
	/**
	 * Checks the record's saved input against the recipe's schema before `setup` runs
	 * again. A record outlives a deploy, and an input schema can change, so the old
	 * input is not trusted just because it was ours (found in review, step 3).
	 */
	inputCheck?: (input: JsonValue) => Validation<JsonValue>;
	system: string;
	tools: readonly Tool[];
	model: ModelSlot;
	storage: StorageSlot;
	clock: Clock;
	ids: Ids;
	/** The model a recipe names, when it names one. */
	modelName?: string;
	/** The model to move to when the first fails its retries (decision 58). */
	fallbackModel?: string;
	/** What the recipe allows before the run parks (decision 18, LIM01). */
	limits?: Limits;
	/** What the run's owner may steer or follow up with while it runs. */
	control?: RunControl;
	/** The stuck safeguard: on by default, because the default has no limits (decision 25). */
	stuck?: StuckSettings;
	/** The recipe this run is held to, whose pin goes in the header (decision 91). */
	recipe?: { name: string; version: number };
	/**
	 * Continue a record instead of starting one (decision 20). `by` decides what may
	 * be continued: an accident resumes on its own, everything else waits for a
	 * person (decision 23).
	 */
	resume?: { lines: readonly string[]; by: "wake" | "person" };
	toolDeadlineMs?: number;
	/** The record's entry cap. Lowered to the storage's own limit when that is smaller. */
	entryCapBytes?: number;
	signal?: AbortSignal;
	onEvent?: RunEventListener;
}

export interface RunResult {
	reason: RunEndReason;
	parkedReason?: ParkedReason;
	/** Which part of the reason stopped it, such as a limit's `steps` or `tokens`. */
	parkedDetail?: string;
	/** Summed over every reply. Cost is only carried when every reply reported one. */
	usage: Usage;
	/** How many times the model was asked. */
	turns: number;
	error?: LyraError;
	/** The recipe's state when the run has one, live or rebuilt from the record. */
	state?: unknown;
}

/**
 * A reply's call ids, made usable before anything is written (LOOP09).
 *
 * The id is what pairs a call with its result, so an empty one or a repeated one
 * would make the record and the conversation disagree: a provider rejects a tool
 * result that matches no call, and the record refuses a tool message with no id.
 * Both are the model's doing, so the run assigns the id here, once, before the
 * assistant message is saved and before the batch runs.
 */
function normalizeCalls(calls: readonly ToolCall[], ids: Ids): ToolCall[] {
	// Every id the reply already uses, including ones further along the batch: a
	// generated id must not collide with a call that has not been reached yet, or
	// the duplicate is simply recreated in a different place.
	const used = new Set<string>();
	for (const call of calls) {
		if (call.id !== "") {
			used.add(call.id);
		}
	}
	const seen = new Set<string>();

	return calls.map((call) => {
		if (call.id !== "" && !seen.has(call.id)) {
			seen.add(call.id);
			return call;
		}
		let fresh = ids.next("c");
		while (used.has(fresh)) {
			fresh = ids.next("c");
		}
		used.add(fresh);
		seen.add(fresh);
		return { ...call, id: fresh };
	});
}

/**
 * A failed save, thrown to leave the loop. It never crosses the module boundary:
 * `runTask` catches it and ends the run with `failed` (errors are data at the
 * edge, and this is the middle).
 */
class SaveFailed {
	constructor(readonly error: LyraError) {}
}

function messageOf(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return text.slice(0, 500);
}

/**
 * Tokens always add up. A cost total only means something when every reply
 * reported one, from the same kind of billing (decision 15), so one reply without
 * a cost drops the total for the run instead of reporting a number that is too low.
 *
 * A cost *limit* is different: it compares against every amount reported, whatever
 * its source, and it is unenforceable as soon as one reply reports none, because
 * the total is then understated (LIM05).
 */
function createUsageTotal() {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost: Usage["cost"] | undefined;
	let costKnown = true;
	let spent = 0;
	let everyCostReported = true;

	return {
		add(next: Usage): void {
			inputTokens += next.inputTokens;
			outputTokens += next.outputTokens;
			if (next.cost === undefined) {
				everyCostReported = false;
			} else {
				spent += next.cost.amount;
			}
			if (!costKnown) {
				return;
			}
			if (next.cost === undefined) {
				costKnown = false;
			} else if (cost === undefined) {
				cost = next.cost;
			} else if (cost.source === next.cost.source) {
				cost = {
					amount: cost.amount + next.cost.amount,
					currency: "USD",
					source: cost.source,
				};
			} else {
				costKnown = false;
			}
		},

		total(): Usage {
			const sum: Usage = { inputTokens, outputTokens };
			if (costKnown && cost !== undefined) {
				sum.cost = cost;
			}
			return sum;
		},

		tokens(): number {
			return inputTokens + outputTokens;
		},

		costSpent(): { amount: number; known: boolean } {
			return { amount: spent, known: everyCostReported };
		},
	};
}

/**
 * A parked reason as this build knows it. A record written by a newer Lyra may name
 * one that is not here, and guessing would overrule a person's decision, so an
 * unknown reason is reported as `stuck` with the raw reason kept in the detail.
 */
const KNOWN_PARKED_REASONS: readonly ParkedReason[] = [
	"stopped",
	"stuck",
	"limit",
	"model_unavailable",
];

function parkedReasonOf(reason: string | undefined): ParkedReason {
	return KNOWN_PARKED_REASONS.find((known) => known === reason) ?? "stuck";
}

export async function runTask(config: RunConfig): Promise<RunResult> {
	const clock = config.clock;
	const runId = config.runId;
	const deadlineMs = config.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS;
	const entryCap = entryCapBytes(config.storage, config.entryCapBytes);
	const signal = config.signal ?? new AbortController().signal;
	const control = config.control;

	const messages: ConversationMessage[] = [];
	const tools = new Map<string, Tool>(config.tools.map((tool) => [tool.spec.name, tool]));

	let live = true;
	/**
	 * The recipe's state, when it has one. It starts at what `setup` made, changes
	 * only inside a tool's `apply`, and is rebuilt from the record on a resume.
	 */
	let state: unknown;
	/** Set once the header is saved. Nothing is written into a record that never started. */
	let recordStarted = false;
	const usageTotal = createUsageTotal();
	let turns = 0;
	/** The id of the entry before the next one, which is what `parent` records. */
	let parent: string | null = null;
	/** The clock time the run's latest `running` or `resumed` status was saved. */
	let activeSince = clock.now();
	/** Active milliseconds already spent before this segment began (LIM04, LIM06). */
	let closedActiveMs = 0;
	/** The model the next request names: the recipe's, or the fallback once it moves. */
	let modelName = config.modelName;
	/** A cost limit the run cannot measure is noted once, not once per reply (LIM05). */
	let costLimitNoted = false;
	const stuck = {
		enabled: config.stuck?.enabled ?? true,
		reminders: config.stuck?.reminders ?? 2,
		sameFailure: config.stuck?.sameFailure ?? 3,
	};
	let remindersSent = 0;
	/** The key of the last tool failure, and how many in a row it has happened (STK03). */
	let lastFailureKey: string | undefined;
	let failuresInARow = 0;
	/** Set when the same failure has happened often enough to stop the run (STK03). */
	let repeatedFailure: string | undefined;

	const emit = (event: RunEvent): void => {
		if (!live) {
			return;
		}
		if (event.type === "run_end") {
			// Nothing is emitted after the end, even if a listener is called again.
			live = false;
		}
		try {
			config.onEvent?.(event);
		} catch {
			// A listener is not allowed to be the reason a run fails (LOOP11).
		}
	};

	const save = async (line: string): Promise<number> => {
		const saved = await config.storage.append(line);
		if (!saved.ok) {
			throw new SaveFailed(saved.error);
		}
		return saved.value.seq;
	};

	const append = async (entry: RecordEntry): Promise<number> => {
		const fitted = fitEntry(entry, entryCap);
		if (fitted.refused !== undefined) {
			throw new SaveFailed({ code: "internal", message: fitted.refused });
		}
		return appendLine(entry, fitted.line);
	};

	const appendLine = async (entry: RecordEntry, line: string): Promise<number> => {
		if (!recordStarted) {
			// A record with no header is not a record, so nothing is written into one
			// that never started: a resume would have nothing to read either way.
			throw new SaveFailed({ code: "internal", message: "the record has no header" });
		}
		const seq = await save(line);
		parent = entry.id;
		return seq;
	};

	const saveStatus = async (
		state: StatusEntry["state"],
		reason?: string,
		detail?: string,
	): Promise<number> => {
		const entry: StatusEntry = {
			type: "status",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			state,
		};
		if (reason !== undefined) {
			entry.reason = reason;
		}
		if (detail !== undefined) {
			entry.detail = detail;
		}
		return append(entry);
	};

	const saveNote = async (kind: string, text: string): Promise<number> => {
		const entry: NoteEntry = {
			type: "note",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			kind,
			text,
		};
		return append(entry);
	};

	/** The record says which model took over and why, once per run (decision 58). */
	const saveFallback = async (from: string, to: string, reason: string): Promise<number> => {
		const entry: FallbackEntry = {
			type: "fallback",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			from,
			to,
			reason,
		};
		return append(entry);
	};

	/** Count a failure, resetting on a different one or on a success (STK03, STK04). */
	const noteFailure = (name: string, content: string): void => {
		const key = `${name}\u0000${content.slice(0, 200)}`;
		if (key === lastFailureKey) {
			failuresInARow += 1;
		} else {
			lastFailureKey = key;
			failuresInARow = 1;
		}
		if (stuck.enabled && failuresInARow >= stuck.sameFailure) {
			repeatedFailure = name === "" ? "a reply cut off by the token limit" : name;
		}
	};

	const noteSuccess = (): void => {
		lastFailureKey = undefined;
		failuresInARow = 0;
	};

	/**
	 * Whether the current recipe's tools differ from the record's pin, which is what
	 * parks a resume for a person to look at (REC07, REC08). A run already parked for
	 * exactly that is the person's decision to make, so the next resume continues.
	 */
	const recipeChangeParked = (
		seed: ResumeSeed,
		current: RecipeStamp | undefined,
	): string | undefined => {
		if (current === undefined || seed.pin === undefined) {
			return undefined;
		}
		if (current.toolSetHash === seed.pin.toolSetHash) {
			return undefined;
		}
		if (seed.status?.state === "parked" && seed.status.detail?.startsWith("recipe_changed")) {
			return undefined;
		}
		const change = compareTools(seed.pin.tools, current.tools);
		return `recipe_changed: ${describeChange(change, seed.usedTools)}`;
	};

	/** Move the record's pin, and write it only when something actually moved (REC06). */
	const noteRecipeChange = async (seed: ResumeSeed, current: RecipeStamp): Promise<void> => {
		const pinned = seed.pin;
		if (pinned === undefined) {
			await saveRecipeUpdated(undefined, current);
			return;
		}
		if (
			current.toolSetHash === pinned.toolSetHash &&
			current.version === pinned.version &&
			current.instructionsHash === pinned.instructionsHash
		) {
			return;
		}
		await saveRecipeUpdated(pinned, current);
	};

	/** The pin the record is held to from now on (REC06, REC09). */
	const saveRecipeUpdated = async (
		from: RecipeStamp | undefined,
		to: RecipeStamp,
	): Promise<number> => {
		const entry: RecipeUpdatedEntry = {
			type: "recipe_updated",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			to,
		};
		if (from !== undefined) {
			entry.from = from;
		}
		return append(entry);
	};

	/** A steer or a follow-up, written where it can be read without breaking a pairing. */
	const saveUserMessage = async (
		label: "steer" | "follow_up",
		message: QueuedMessage,
	): Promise<number> => {
		const entry: UserMessageEntry = {
			type: "user_message",
			id: message.id,
			parent,
			ts: message.ts,
			label,
			text: message.text,
		};
		const seq = await append(entry);
		messages.push({ role: "user", text: message.text });
		return seq;
	};

	/**
	 * Read what the run's owner queued, at a gap. Returns whether anything arrived,
	 * which is how the loop knows to continue instead of ending.
	 */
	const readQueued = async (kind: "steer" | "follow_up"): Promise<boolean> => {
		if (control === undefined) {
			return false;
		}
		const queued = kind === "steer" ? control.takeSteers() : control.takeFollowUps();
		for (const message of queued) {
			await saveUserMessage(kind, message);
		}
		return queued.length > 0;
	};

	const saveToolResult = async (call: ToolCall, outcome: ToolOutcome): Promise<number> => {
		const entry: ToolMessageEntry = {
			type: "tool_message",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			toolCallId: call.id,
			isError: outcome.isError,
			content: outcome.content,
		};
		if (outcome.details !== undefined) {
			entry.details = outcome.details;
		}
		if (outcome.done === true) {
			entry.done = true;
		}
		const seq = await append(entry);
		messages.push({
			role: "tool",
			toolCallId: call.id,
			content: outcome.content,
			isError: outcome.isError,
		});
		return seq;
	};

	type Attempt = { ok: true; reply: ModelReply } | { ok: false; error: ModelError };
	type Answered = Attempt & {
		/** How many times this turn was tried again, which the record keeps (decision 26). */
		retries: number;
	};

	/** Ask the model once. A slot that throws is a failed run, not a crash. */
	const askOnce = async (): Promise<Attempt> => {
		const request: ModelRequest = {
			system: config.system,
			messages: [...messages],
			tools: config.tools.map((tool) => tool.spec),
			signal,
		};
		if (modelName !== undefined) {
			request.model = modelName;
		}

		try {
			const answered = await config.model.complete(request);
			if (!answered.ok) {
				return { ok: false, error: answered.error };
			}
			return { ok: true, reply: answered.value };
		} catch (error) {
			// A slot that throws is not worth retrying: it is a bug here, not an outage.
			return {
				ok: false,
				error: { code: "internal", message: messageOf(error), retryable: false },
			};
		}
	};

	/**
	 * Ask the model, trying again on a retryable failure (decision 26). The delays
	 * grow, and the error's own `retryAfterMs` is a floor under them, because a
	 * provider that says when to come back knows better. A stop cancels the wait.
	 */
	const ask = async (): Promise<Answered> => {
		let retries = 0;
		for (;;) {
			const answered = await askOnce();
			const delay = answered.ok ? undefined : RETRY_DELAYS_MS[retries];
			if (answered.ok || !answered.error.retryable || delay === undefined) {
				return { ...answered, retries };
			}
			const waitMs = Math.max(delay, answered.error.retryAfterMs ?? 0);
			emit({
				type: "retry",
				run: runId,
				ts: clock.now(),
				attempt: retries + 1,
				delayMs: waitMs,
				error: answered.error,
			});
			retries += 1;
			try {
				await clock.sleep(waitMs, signal);
			} catch {
				// Stopped while waiting: the caller checks the signal before believing
				// this error, so the run parks `stopped` rather than failing.
				return { ...answered, retries };
			}
		}
	};

	/** Set when a tool's answer says the done-check passed (decision 25). */
	let finishedRun = false;

	/** Run one reply's calls, which is the same work on the first try and after a resume. */
	const runBatch = async (calls: readonly ToolCall[]): Promise<void> => {
		await executeTools({
			calls,
			tools: config.tools,
			clock,
			signal,
			deadlineMs,
			runId,
			isFinished: () => finishedRun,
			readState: () => state,
			onStart: (call) => {
				emit({
					type: "tool_start",
					run: runId,
					ts: clock.now(),
					callId: call.id,
					name: call.name,
				});
			},
			onFinish: async (call, outcome, args) => {
				const resultSeq = await saveToolResult(call, outcome);
				emit({
					type: "tool_end",
					run: runId,
					ts: clock.now(),
					seq: resultSeq,
					callId: call.id,
					name: call.name,
					isError: outcome.isError,
					content: outcome.content,
				});
				if (outcome.isError) {
					noteFailure(call.name, outcome.content);
				} else {
					noteSuccess();
				}
				if (outcome.done === true && !outcome.isError) {
					finishedRun = true;
				}
				// One writer, and only a success: the same call a resume replays, so a
				// live run and a rebuilt one cannot drift (decision 112, TOL08).
				const tool = tools.get(call.name);
				if (!outcome.isError && args !== undefined && tool?.apply !== undefined) {
					state = tool.apply(state, args, outcome);
				}
			},
		});
	};

	/**
	 * Answer the calls the record has no result for, which is where a kill leaves a
	 * run. A call that is safe to repeat runs now; one that is not is answered with
	 * an unknown outcome and never repeated, because the record cannot tell a tool
	 * that never started from one that changed something and then died (decision 24).
	 */
	const answerUnanswered = async (seed: ResumeSeed): Promise<void> => {
		for (const call of seed.unansweredCalls) {
			const tool = tools.get(call.name);
			if (tool !== undefined && tool.safeToRepeat === true) {
				await runBatch([call]);
				continue;
			}
			emit({ type: "tool_call", run: runId, ts: clock.now(), call });
			const unknown: ToolOutcome = {
				isError: true,
				content:
					"outcome unknown: this call may or may not have run; check before repeating",
			};
			const resultSeq = await saveToolResult(call, unknown);
			emit({
				type: "tool_end",
				run: runId,
				ts: clock.now(),
				seq: resultSeq,
				callId: call.id,
				name: call.name,
				isError: true,
				content: unknown.content,
			});
		}
	};

	/**
	 * The ending the record already holds, when a resume has nothing to do. A wake
	 * continues only a run that was `running`, so an accident resumes on its own and
	 * everything else waits for a person (decision 23).
	 */
	const recordedOutcome = (seed: ResumeSeed, by: "wake" | "person"): RunResult | undefined => {
		const status = seed.status;
		if (status === undefined) {
			return undefined;
		}
		const total = usageTotal.total();
		if (status.state === "done") {
			return { reason: "done", usage: total, turns };
		}
		if (status.state === "failed") {
			return {
				reason: "failed",
				error: { code: "internal", message: "the record says the run failed" },
				usage: total,
				turns,
			};
		}
		if (status.state === "parked" && by === "wake") {
			return {
				reason: "parked",
				parkedReason: parkedReasonOf(status.reason),
				...(status.detail === undefined ? {} : { parkedDetail: status.detail }),
				usage: total,
				turns,
			};
		}
		return undefined;
	};

	/** A stopped run parks rather than failing: a person stopping it is not an error (decision 23). */
	const stopped = (): RunResult | undefined =>
		signal.aborted
			? { reason: "parked", parkedReason: "stopped", usage: usageTotal.total(), turns }
			: undefined;

	// A bad limit fails here rather than parking a run that cannot start (LIM03).
	const checkedLimits = config.limits === undefined ? undefined : validateLimits(config.limits);
	const limits =
		checkedLimits !== undefined && checkedLimits.ok ? checkedLimits.value : undefined;

	const loop = async (): Promise<RunResult> => {
		for (;;) {
			const stoppedBeforeAsking = stopped();
			if (stoppedBeforeAsking !== undefined) {
				return stoppedBeforeAsking;
			}

			// The gap: the last step's entries are all saved and the next request has not
			// been made, so a steer is written here without splitting a call from its
			// result (decision 19, STP02). It is written before the limit is checked, so
			// a run that parks now still carries it for the resume.
			await readQueued("steer");

			// Checked before each request, so a limit always lands on a step boundary.
			const reached = reachedLimit(limits, {
				turns,
				tokens: usageTotal.tokens(),
				cost: usageTotal.costSpent(),
				activeMs: closedActiveMs + (clock.now() - activeSince),
			});
			if (reached !== undefined) {
				return {
					reason: "parked",
					parkedReason: "limit",
					parkedDetail: reached,
					usage: usageTotal.total(),
					turns,
				};
			}

			// A turn is one step, however many times it is retried.
			turns += 1;
			emit({ type: "turn_start", run: runId, ts: clock.now(), turn: turns });

			const answered = await ask();
			if (!answered.ok) {
				// An abort during the request is a person stopping the run, not the
				// model failing, so the signal is checked before the error is believed.
				const stoppedWhileAsking = stopped();
				if (stoppedWhileAsking !== undefined) {
					return stoppedWhileAsking;
				}
				emit({ type: "error", run: runId, ts: clock.now(), error: answered.error });
				// A non-retryable error is a bug rather than an outage, so it still
				// ends the run `failed`; only an exhausted retryable one parks.
				if (!answered.error.retryable) {
					return {
						reason: "failed",
						error: answered.error,
						usage: usageTotal.total(),
						turns,
					};
				}
				const fallback = config.fallbackModel;
				if (fallback !== undefined && modelName !== fallback) {
					const reason = `${answered.error.code}: ${answered.error.message.slice(0, 200)}`;
					const from = modelName ?? "default";
					await saveFallback(from, fallback, reason);
					emit({
						type: "fallback",
						run: runId,
						ts: clock.now(),
						from,
						to: fallback,
						reason,
					});
					modelName = fallback;
					continue;
				}
				return {
					reason: "parked",
					parkedReason: "model_unavailable",
					parkedDetail: `${answered.error.code}: ${answered.error.message.slice(0, 200)}`,
					usage: usageTotal.total(),
					turns,
				};
			}
			const reply = answered.reply;
			const calls = normalizeCalls(reply.toolCalls, config.ids);

			usageTotal.add(reply.usage);
			emit(
				reply.usage.cost === undefined
					? {
							type: "usage",
							run: runId,
							ts: clock.now(),
							inputTokens: reply.usage.inputTokens,
							outputTokens: reply.usage.outputTokens,
						}
					: {
							type: "usage",
							run: runId,
							ts: clock.now(),
							inputTokens: reply.usage.inputTokens,
							outputTokens: reply.usage.outputTokens,
							cost: reply.usage.cost,
						},
			);

			const entry: AssistantMessageEntry = {
				type: "assistant_message",
				id: config.ids.next("e"),
				parent,
				ts: clock.now(),
				text: reply.text,
				toolCalls: calls,
				model: reply.model,
				usage: reply.usage,
				finishReason: reply.finishReason,
			};
			if (answered.retries > 0) {
				entry.retries = answered.retries;
			}
			if (reply.reasoning !== undefined) {
				entry.reasoning = reply.reasoning;
			}
			const seq = await append(entry);
			emit({
				type: "message_end",
				run: runId,
				ts: clock.now(),
				seq,
				text: reply.text,
				toolCalls: calls,
			});

			const assistant: ConversationMessage =
				reply.reasoning === undefined
					? { role: "assistant", text: reply.text, toolCalls: calls }
					: {
							role: "assistant",
							text: reply.text,
							reasoning: reply.reasoning,
							toolCalls: calls,
						};
			messages.push(assistant);

			// A cost limit it cannot measure is not a limit, so the run says so once
			// and carries on without enforcing it (decision 15, LIM05).
			if (limits?.cost !== undefined && !costLimitNoted && !usageTotal.costSpent().known) {
				costLimitNoted = true;
				await saveNote(
					"limit_unenforceable",
					"a cost limit is set, but a reply reported no cost, so the limit cannot be enforced for this run",
				);
			}

			// A reply cut off by the token limit can hold half-written arguments, so
			// none of its calls run: each is answered with an error and the model is
			// asked again (decision 25).
			if (reply.finishReason === "length" && calls.length > 0) {
				for (const call of calls) {
					emit({ type: "tool_call", run: runId, ts: clock.now(), call });
					const cutOff: ToolOutcome = {
						isError: true,
						content:
							"this call was not run: the reply was cut off by the token limit, so its arguments may be incomplete",
					};
					const resultSeq = await saveToolResult(call, cutOff);
					emit({
						type: "tool_end",
						run: runId,
						ts: clock.now(),
						seq: resultSeq,
						callId: call.id,
						name: call.name,
						isError: true,
						content: cutOff.content,
					});
				}
				emit({
					type: "turn_end",
					run: runId,
					ts: clock.now(),
					turn: turns,
					finishReason: reply.finishReason,
				});
				// A cut-off reply is a failure of its own kind, asked again and
				// counted toward the same-failure total (decision 25, STK06).
				noteFailure("", "the reply was cut off by the token limit");
				if (repeatedFailure !== undefined) {
					return {
						reason: "parked",
						parkedReason: "stuck",
						parkedDetail: `repeated_failure: ${repeatedFailure}`,
						usage: usageTotal.total(),
						turns,
					};
				}
				continue;
			}

			if (calls.length === 0) {
				// No tool call and no `finish`: the model has stopped without saying the
				// job is done. A follow-up is a person's next word, so it is read before
				// the run is called stuck. Slice 5 adds the reminders.
				emit({
					type: "turn_end",
					run: runId,
					ts: clock.now(),
					turn: turns,
					finishReason: reply.finishReason,
				});
				if (await readQueued("follow_up")) {
					continue;
				}
				// The safeguard: a model that stops without finishing is nudged, and
				// only a model that stays silent after every nudge parks the run.
				if (stuck.enabled && remindersSent < stuck.reminders) {
					remindersSent += 1;
					const reminder: UserMessageEntry = {
						type: "user_message",
						id: config.ids.next("e"),
						parent,
						ts: clock.now(),
						label: "reminder",
						text: REMINDER_TEXT,
					};
					await append(reminder);
					messages.push({ role: "user", text: REMINDER_TEXT });
					continue;
				}
				if (!stuck.enabled) {
					// The safeguard is off, so there is nothing left to try: the run says
					// so rather than reporting a done-check that never passed (STK05).
					const error: LyraError = {
						code: "internal",
						message:
							"the model stopped without finishing, and the stuck safeguard is off",
					};
					emit({ type: "error", run: runId, ts: clock.now(), error });
					return {
						reason: "failed",
						error,
						usage: usageTotal.total(),
						turns,
					};
				}
				return {
					reason: "parked",
					parkedReason: "stuck",
					parkedDetail: "stopped_without_finishing",
					usage: usageTotal.total(),
					turns,
				};
			}

			for (const call of calls) {
				emit({ type: "tool_call", run: runId, ts: clock.now(), call });
			}

			await runBatch(calls);

			emit({
				type: "turn_end",
				run: runId,
				ts: clock.now(),
				turn: turns,
				finishReason: reply.finishReason,
			});
			if (repeatedFailure !== undefined) {
				// The same tool failed the same way often enough: park rather than
				// spend the person's allowance on a loop that cannot progress (STK03).
				return {
					reason: "parked",
					parkedReason: "stuck",
					parkedDetail: `repeated_failure: ${repeatedFailure}`,
					usage: usageTotal.total(),
					turns,
				};
			}
			if (finishedRun) {
				// The run would end here, so this is where a person's follow-up is read.
				if (await readQueued("follow_up")) {
					// The follow-up asks for new work, so the finish that came before it no
					// longer ends the run: a stale flag would refuse every call of the turn
					// it caused (found in review).
					finishedRun = false;
					continue;
				}
				return { reason: "done", usage: usageTotal.total(), turns };
			}
		}
	};

	let result: RunResult;
	/** True when a resume ended on the record's own word, so nothing new is written. */
	let nothingWritten = false;
	try {
		// A task input is never truncated: half a request would be a different job,
		// so one that cannot fit is refused and nothing is saved (decision 90). A
		// recipe's input is measured with it, because it is saved in the details for
		// the resume that has to rebuild the state (decision 112).
		const makeFirst = (text: string, input: JsonValue | undefined): UserMessageEntry => {
			const entry: UserMessageEntry = {
				type: "user_message",
				id: config.ids.next("e"),
				parent,
				ts: clock.now(),
				label: "task",
				text,
			};
			if (input !== undefined) {
				entry.details = { input };
			}
			return entry;
		};
		const firstFits = (entry: UserMessageEntry): boolean =>
			utf8Length(encodeEntry(entry)) <= entryCap;

		emit({ type: "run_start", run: runId, ts: clock.now(), task: config.task });

		const refused =
			checkedLimits !== undefined && !checkedLimits.ok ? checkedLimits.error : undefined;
		if (refused !== undefined) {
			emit({ type: "error", run: runId, ts: clock.now(), error: refused });
			result = { reason: "failed", error: refused, usage: usageTotal.total(), turns };
		} else if (config.resume !== undefined) {
			const seeded = readResumeSeed(config.resume.lines);
			if (!seeded.ok) {
				const error: LyraError = {
					code: "internal",
					message: `the record could not be read: ${seeded.error.message}`,
				};
				emit({ type: "error", run: runId, ts: clock.now(), error });
				result = { reason: "failed", error, usage: usageTotal.total(), turns };
			} else if (seeded.value.record.header.run !== runId) {
				const error: LyraError = {
					code: "internal",
					message: "the record belongs to another run",
				};
				emit({ type: "error", run: runId, ts: clock.now(), error });
				result = { reason: "failed", error, usage: usageTotal.total(), turns };
			} else {
				const seed = seeded.value;
				// The record is already there, so writes are allowed from this point.
				recordStarted = true;
				reserveIds(config.ids, seed.record.entries);
				// What the record already spent counts from the first line, so a limit
				// means the same thing on both sides of an interruption (LIM06).
				for (const usage of seed.usages) {
					usageTotal.add(usage);
				}
				messages.push(...seed.messages);
				turns = seed.turns;
				parent = seed.parent;
				closedActiveMs = seed.activeMs;
				// A recipe's state comes back from its own `setup` and the saved results,
				// before anything new runs (decision 112). Without the input the record
				// cannot rebuild it, and guessing would invent a page.
				let prepared: TaskStart | undefined;
				if (config.setup !== undefined) {
					if (seed.input === undefined) {
						throw new Error(
							"the record has no task input to rebuild the recipe's state",
						);
					}
					const checked = config.inputCheck?.(seed.input);
					if (checked !== undefined && !checked.ok) {
						throw new Error(
							`the record's task input no longer matches the recipe's input schema, so the run cannot be rebuilt: ${formatErrors(checked.errors, "invalid input")}`,
						);
					}
					prepared = config.setup(seed.input);
					state = replayState(prepared.state, seed.record.entries, tools);
				}
				if (seed.messages.length === 0) {
					// The kill landed after the header and before the task message, so the
					// resume writes the job the caller is asking for. This comes after the
					// seed sets `parent`, or the write would leave the message orphaned.
					const first = makeFirst(prepared?.message ?? config.input, seed.input);
					await append(first);
					messages.push({ role: "user", text: first.text });
				}

				const recorded = recordedOutcome(seed, config.resume.by);
				const current =
					config.recipe === undefined
						? undefined
						: await pinRecipe({
								name: config.recipe.name,
								version: config.recipe.version,
								instructions: config.system,
								tools: config.tools.map((tool) => tool.spec),
							});
				if (recorded !== undefined) {
					// Nothing is written: the record already says how this run ended, or
					// that it waits for a person.
					nothingWritten = true;
					result = recorded;
				} else if (seed.finished) {
					// A kill landed between an accepted finish and the closing status. The
					// record already knows the done-check passed, so the run ends done
					// rather than asking the model for a turn it already gave.
					recordStarted = true;
					result = { reason: "done", usage: usageTotal.total(), turns };
				} else if (recipeChangeParked(seed, current) !== undefined) {
					// A tool set that differs from the pin waits for a person (REC07, REC08);
					// the closing status below writes the one park, with the reason.
					result = {
						reason: "parked",
						parkedReason: "stuck",
						parkedDetail: recipeChangeParked(seed, current) ?? "recipe_changed",
						usage: usageTotal.total(),
						turns,
					};
				} else {
					if (current !== undefined) {
						await noteRecipeChange(seed, current);
					}
					await saveStatus("resumed");
					activeSince = clock.now();
					await answerUnanswered(seed);
					// A repeated safe call may itself have passed the done-check (a
					// finish is safe to repeat for exactly this reason).
					result = finishedRun
						? { reason: "done", usage: usageTotal.total(), turns }
						: await loop();
				}
			}
		} else {
			// A recipe's `setup` makes the first message and the state together, so a
			// fresh run and a resumed one start from the same place (decision 112).
			const prepared =
				config.setup === undefined
					? undefined
					: config.setup(config.inputValue ?? config.input);
			const first = makeFirst(prepared?.message ?? config.input, config.inputValue);
			if (!firstFits(first)) {
				const error: LyraError = {
					code: "bad_request",
					message: `the task input is bigger than one record entry can hold (${entryCap} bytes)`,
				};
				emit({ type: "error", run: runId, ts: clock.now(), error });
				result = { reason: "failed", error, usage: usageTotal.total(), turns };
			} else {
				const header: RecordHeader = {
					type: "header",
					v: RECORD_VERSION,
					run: runId,
					task: config.task,
					startedAt: clock.now(),
					host: config.host,
				};
				if (config.recipe !== undefined) {
					// The pin is what a later resume is held to, so it is taken before the
					// first line and never guessed (decision 91).
					header.recipe = await pinRecipe({
						name: config.recipe.name,
						version: config.recipe.version,
						instructions: config.system,
						tools: config.tools.map((tool) => tool.spec),
					});
				}
				await save(encodeHeader(header));
				recordStarted = true;

				await append(first);
				messages.push({ role: "user", text: first.text });
				state = prepared?.state;
				await saveStatus("running");
				activeSince = clock.now();

				result = await loop();
			}
		}
	} catch (caught) {
		const error: LyraError =
			caught instanceof SaveFailed
				? {
						code: caught.error.code,
						message: `the record could not be saved: ${caught.error.message}`,
					}
				: { code: "internal", message: messageOf(caught) };
		emit({ type: "error", run: runId, ts: clock.now(), error });
		result = { reason: "failed", error, usage: usageTotal.total(), turns };
	}

	// The closing status, and the one `run_end`, whatever happened above. If the
	// closing status cannot be written, the record is not finished either, so the
	// run reports `failed` rather than an ending nobody can resume from.
	try {
		if (!nothingWritten) {
			await saveStatus(
				result.reason === "done"
					? "done"
					: result.reason === "parked"
						? "parked"
						: "failed",
				result.reason === "parked" ? result.parkedReason : undefined,
				result.reason === "parked" ? result.parkedDetail : undefined,
			);
		}
	} catch (caught) {
		if (result.reason !== "failed") {
			const error: LyraError =
				caught instanceof SaveFailed
					? {
							code: caught.error.code,
							message: `the record could not be finished: ${caught.error.message}`,
						}
					: { code: "internal", message: messageOf(caught) };
			emit({ type: "error", run: runId, ts: clock.now(), error });
			result = { reason: "failed", error, usage: result.usage, turns: result.turns };
		}
	}

	if (config.setup !== undefined) {
		result = { ...result, state };
	}

	emit(
		result.reason === "parked" && result.parkedReason !== undefined
			? {
					type: "run_end",
					run: runId,
					ts: clock.now(),
					reason: result.reason,
					parkedReason: result.parkedReason,
					...(result.parkedDetail === undefined ? {} : { detail: result.parkedDetail }),
				}
			: { type: "run_end", run: runId, ts: clock.now(), reason: result.reason },
	);
	return result;
}
