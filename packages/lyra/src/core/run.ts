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
import {
	buildView,
	chooseCut,
	DEFAULT_KEEP_TOKENS,
	DEFAULT_SUMMARY_INSTRUCTIONS,
	defaultReserveTokens,
	estimateSinceLastReply,
	shouldCompact,
	summarize,
	summaryMaterial,
	validateCompactionSettings,
	type CompactionSettings,
} from "./compaction.js";
import { executeTools } from "./execute-tools.js";
import {
	parkedReasonOf,
	type ParkedReason,
	type RunEndReason,
	type RunEventListener,
	type RunEvent,
} from "./events.js";
import { reachedLimit, validateLimits, type Limits } from "./limits.js";
import { createUsageTotal } from "./usage.js";
import { compareTools, describeChange, hashText, pinRecipe } from "./recipe.js";
import { RETRY_DELAYS_MS } from "./retry.js";
import type { JsonValue } from "./json.js";
import { formatErrors, type Validation } from "./schema.js";
import { readResumeSeed, reserveIds, type ResumeSeed } from "./resume.js";
import { replayState } from "./state.js";
import type { ModelError, ModelReply, ModelRequest, ModelSlot, ToolCall, Usage } from "./model.js";
import type { LyraError } from "./result.js";
import { entryMessage } from "../record/replay.js";
import type { StorageSlot } from "./slots.js";
import type { Tool, ToolOutcome } from "./tool.js";
import { fitEntry, utf8Length } from "../record/truncate.js";
import {
	RECORD_VERSION,
	encodeEntry,
	encodeHeader,
	type AssistantMessageEntry,
	type CompactionEntry,
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
	/** How the recipe shapes compaction, when it says anything (decision 41). */
	compaction?: CompactionSettings;
	/** What the run's owner may steer or follow up with while it runs. */
	control?: RunControl;
	/** The stuck safeguard: on by default, because the default has no limits (decision 25). */
	stuck?: StuckSettings;
	/** The recipe this run is held to, whose pin goes in the header (decision 91). */
	recipe?: { name: string; version: number };
	/** Whose session this is, written on the header so a host can refuse another tenant. */
	tenant?: string;
	/**
	 * Continue a record instead of starting one (decision 20). `by` decides what may
	 * be continued: an accident resumes on its own, everything else waits for a
	 * person (decision 23). `followUp` is a message a person adds while continuing a
	 * record that has ended, which opens a new segment of the same run (decision 44).
	 */
	resume?: { lines: readonly string[]; by: "wake" | "person"; followUp?: string };
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

export async function runTask(config: RunConfig): Promise<RunResult> {
	const clock = config.clock;
	const runId = config.runId;
	const deadlineMs = config.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS;
	const entryCap = entryCapBytes(config.storage, config.entryCapBytes);
	const signal = config.signal ?? new AbortController().signal;
	const control = config.control;

	/**
	 * The conversation as the model sees it: the latest summary, each tool's current
	 * state, and the entries the record's pointer keeps. It is rebuilt from the
	 * record at a compaction, so the live view and a resumed one cannot drift.
	 */
	let messages: ConversationMessage[] = [];
	/** The entries the view keeps, which is what a later cut is chosen from. */
	let viewEntries: RecordEntry[] = [];
	/** The latest summary, which a new one updates rather than restarts (decision 40). */
	let previousSummary: string | undefined;
	/** The last request's reported input tokens, which the estimate starts from. */
	let lastInputTokens: number | undefined;
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
		// One place keeps the conversation in step with the record: an entry the model
		// would read becomes a message. A compaction is the caller's to handle, because
		// it rebuilds the view rather than adding to it.
		const message = entryMessage(entry);
		if (message !== undefined) {
			viewEntries.push(entry);
			messages.push(message);
		}
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
		return append(entry);
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
		return append(entry);
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
		// A person who brings a follow-up is asking for more, so an ending already on
		// the record no longer answers them: the run goes on from where it stopped.
		const continues = by === "person" && config.resume?.followUp !== undefined;
		const total = usageTotal.total();
		if (status.state === "done" && !continues) {
			return { reason: "done", usage: total, turns };
		}
		if (status.state === "failed" && !continues) {
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

	/** Why a failed run failed, when it has a reason worth keeping on the record. */
	let failureDetail: string | undefined;

	// A window is the model slot's unless the recipe overrides it. Without one, the
	// run never compacts on its own: there is no number to compare against
	// (decision 41), and the manual command is the only way to ask for a summary.
	const contextWindow = config.compaction?.contextWindow ?? config.model.contextWindow;
	const reserveTokens =
		config.compaction?.reserveTokens ??
		(contextWindow === undefined ? 0 : defaultReserveTokens(contextWindow));
	const keepTokens = config.compaction?.keepTokens ?? DEFAULT_KEEP_TOKENS;
	const summaryInstructions = config.compaction?.instructions ?? DEFAULT_SUMMARY_INSTRUCTIONS;
	const summaryModel = config.compaction?.model;

	/** The view as a summary call sees it: the summary it updates, and the steps since. */
	const viewFor = (): Parameters<typeof summaryMaterial>[0] => ({
		entries: viewEntries,
		summary: previousSummary,
		stateTexts: [],
		messages,
	});

	/**
	 * Compact if the next request would come too close to the model's window.
	 *
	 * It runs before the request it makes room for, and it is the only place the
	 * record's view changes. A failure parks the run as `model_unavailable` with
	 * the detail `compaction_failed`: continuing without the summary would mean
	 * sending a request the model cannot read.
	 */
	const compactIfNeeded = async (): Promise<RunResult | undefined> => {
		if (contextWindow === undefined) {
			return undefined;
		}
		const estimate = (lastInputTokens ?? 0) + estimateSinceLastReply(messages);
		if (!shouldCompact(estimate, contextWindow, reserveTokens)) {
			return undefined;
		}

		const cut = chooseCut(viewEntries, keepTokens);
		if (cut === undefined) {
			if (estimate <= contextWindow) {
				// There is nothing older to summarize yet, and the request still fits.
				return undefined;
			}
			// No summary can make a single step fit, so the run says so plainly rather
			// than spending a call on it and failing differently (decision 6's limit).
			const error: LyraError = {
				code: "bad_request",
				message: `input_too_large: the conversation is about ${estimate} tokens and this model's context window is ${contextWindow}, so compacting cannot make it fit`,
			};
			emit({ type: "error", run: runId, ts: clock.now(), error });
			failureDetail = "input_too_large";
			return { reason: "failed", error, usage: usageTotal.total(), turns };
		}

		const summarized = await summarize({
			summarizer: {
				model: config.model,
				instructions: summaryInstructions,
				...(summaryModel === undefined ? {} : { modelName: summaryModel }),
			},
			material: summaryMaterial(viewFor(), cut),
			clock,
			signal,
			onRetry: (attempt, delayMs, error) => {
				emit({ type: "retry", run: runId, ts: clock.now(), attempt, delayMs, error });
			},
		});
		if (!summarized.ok) {
			const stoppedWhileCompacting = stopped();
			if (stoppedWhileCompacting !== undefined) {
				return stoppedWhileCompacting;
			}
			emit({ type: "error", run: runId, ts: clock.now(), error: summarized.error });
			return {
				reason: "parked",
				parkedReason: "model_unavailable",
				parkedDetail: "compaction_failed",
				usage: usageTotal.total(),
				turns,
			};
		}

		// The summary is a call like any other, so it counts toward what the run
		// spent and toward its token limit (decision 40).
		usageTotal.add(summarized.value.usage);
		const entry: CompactionEntry = {
			type: "compaction",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			summary: summarized.value.summary,
			firstKept: cut.firstKept,
			replaces: cut.replaces,
			usage: summarized.value.usage,
			model: summarized.value.model,
			trigger: "auto",
			instructionsHash: await hashText(summaryInstructions),
		};
		const seq = await append(entry);
		emit({
			type: "compaction",
			run: runId,
			ts: clock.now(),
			seq,
			summary: entry.summary,
			replaces: entry.replaces,
			trigger: entry.trigger,
		});

		// The view is now the record's: the summary, the tools' state, and the
		// entries the pointer keeps. Nothing before it left the record (decision 39).
		const view = buildView([...viewEntries, entry]);
		viewEntries = view.entries;
		messages = view.messages;
		previousSummary = view.summary;
		return undefined;
	};

	// A bad limit fails here rather than parking a run that cannot start (LIM03).
	const checkedLimits = config.limits === undefined ? undefined : validateLimits(config.limits);
	const limits =
		checkedLimits !== undefined && checkedLimits.ok ? checkedLimits.value : undefined;
	// A compaction setting that cannot mean anything is a recipe's mistake, and it
	// fails here rather than at the first compaction (the same rule as a limit).
	const checkedCompaction =
		config.compaction === undefined ? undefined : validateCompactionSettings(config.compaction);

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

			// Compaction happens at the same gap a steer is read at, before the request
			// it makes room for, so it never splits a call from its result.
			const compacted = await compactIfNeeded();
			if (compacted !== undefined) {
				return compacted;
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
			// What this request actually cost the provider is the base the next
			// compaction estimate starts from (decision 41).
			lastInputTokens = reply.usage.inputTokens;
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
			checkedLimits !== undefined && !checkedLimits.ok
				? checkedLimits.error
				: checkedCompaction !== undefined && !checkedCompaction.ok
					? checkedCompaction.error
					: undefined;
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
				turns = seed.turns;
				lastInputTokens = seed.usages.at(-1)?.inputTokens;
				parent = seed.parent;
				closedActiveMs = seed.activeMs;
				let prepared: TaskStart | undefined;

				/**
				 * A recipe's state comes back from its own `setup` and the saved results
				 * (decision 112). Returns why it could not be rebuilt, or nothing when it
				 * did. Without the input there is nothing to run `setup` with, and a
				 * schema that moved under the record's input cannot be rebuilt faithfully.
				 */
				const rebuild = (): string | undefined => {
					if (config.setup === undefined) {
						return undefined;
					}
					if (seed.input === undefined) {
						return "the record has no task input to rebuild the recipe's state";
					}
					const checked = config.inputCheck?.(seed.input);
					if (checked !== undefined && !checked.ok) {
						return `the record's task input no longer matches the recipe's input schema, so the run cannot be rebuilt: ${formatErrors(checked.errors, "invalid input")}`;
					}
					prepared = config.setup(seed.input);
					state = replayState(prepared.state, seed.record.entries, tools);
					return undefined;
				};

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
				const change = recipeChangeParked(seed, current);

				if (recorded !== undefined) {
					// Nothing is written: the record already says how this run ended, or
					// that it waits for a person. The state is only for the caller's
					// benefit, so a rebuild that cannot happen loses it and not the ending.
					nothingWritten = true;
					try {
						rebuild();
					} catch {
						state = undefined;
					}
					result = recorded;
				} else if (seed.finished && config.resume.followUp === undefined) {
					// A kill landed between an accepted finish and the closing status. The
					// record already knows the done-check passed, so the run ends done
					// rather than asking the model for a turn it already gave.
					recordStarted = true;
					try {
						rebuild();
					} catch {
						state = undefined;
					}
					result = { reason: "done", usage: usageTotal.total(), turns };
				} else if (change !== undefined) {
					// A tool set that differs from the pin waits for a person (REC07, REC08);
					// the closing status below writes the one park, with the reason.
					result = {
						reason: "parked",
						parkedReason: "stuck",
						parkedDetail: change,
						usage: usageTotal.total(),
						turns,
					};
				} else {
					// Only a run that is really going on needs a state, and only here is a
					// record that cannot be rebuilt an honest failure.
					const refused = rebuild();
					if (refused !== undefined) {
						throw new Error(refused);
					}
					// The conversation is the record's view, up to the latest compaction's
					// pointer, so a resumed run sees what the compacted one saw (decision 39).
					const seededView = buildView(seed.record.entries);
					viewEntries = seededView.entries;
					messages = seededView.messages;
					previousSummary = seededView.summary;
					if (seed.messages.length === 0) {
						// The kill landed after the header and before the task message, so the
						// resume writes the job the caller is asking for. This comes after the
						// seed sets `parent`, or the write would leave the message orphaned.
						const first = makeFirst(prepared?.message ?? config.input, seed.input);
						await append(first);
					}
					if (current !== undefined) {
						await noteRecipeChange(seed, current);
					}
					await saveStatus("resumed");
					activeSince = clock.now();
					await answerUnanswered(seed);
					// The follow-up comes after any unanswered call is answered, so the
					// conversation never puts a person's message between a call and its result.
					if (config.resume.followUp !== undefined) {
						const message: UserMessageEntry = {
							type: "user_message",
							id: config.ids.next("e"),
							parent,
							ts: clock.now(),
							label: "follow_up",
							text: config.resume.followUp,
						};
						await append(message);
					}
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
					...(config.tenant === undefined ? {} : { tenant: config.tenant }),
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
				result.reason === "parked" ? result.parkedDetail : failureDetail,
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
