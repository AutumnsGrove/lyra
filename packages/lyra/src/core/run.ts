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
import type { ModelReply, ModelRequest, ModelSlot, ToolCall, Usage } from "./model.js";
import type { LyraError } from "./result.js";
import type { StorageSlot } from "./slots.js";
import type { Tool, ToolOutcome } from "./tool.js";
import { fitEntry, utf8Length } from "../record/truncate.js";
import {
	RECORD_VERSION,
	encodeEntry,
	encodeHeader,
	type AssistantMessageEntry,
	type NoteEntry,
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

export interface RunConfig {
	runId: string;
	task: string;
	host: string;
	/** What the person asked for, saved as the first message. */
	input: string;
	system: string;
	tools: readonly Tool[];
	model: ModelSlot;
	storage: StorageSlot;
	clock: Clock;
	ids: Ids;
	/** The model a recipe names, when it names one. */
	modelName?: string;
	/** What the recipe allows before the run parks (decision 18, LIM01). */
	limits?: Limits;
	/** What the run's owner may steer or follow up with while it runs. */
	control?: RunControl;
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
	/** Set once the header is saved. Nothing is written into a record that never started. */
	let recordStarted = false;
	const usageTotal = createUsageTotal();
	let turns = 0;
	/** The id of the entry before the next one, which is what `parent` records. */
	let parent: string | null = null;
	/** The clock time the run's latest `running` status was saved, for the time limit. */
	let activeSince = clock.now();
	/** A cost limit the run cannot measure is noted once, not once per reply (LIM05). */
	let costLimitNoted = false;

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
		const seq = await append(entry);
		messages.push({
			role: "tool",
			toolCallId: call.id,
			content: outcome.content,
			isError: outcome.isError,
		});
		return seq;
	};

	type Answered = { ok: true; reply: ModelReply } | { ok: false; error: LyraError };

	/** Ask the model once. A slot that throws is a failed run, not a crash. */
	const ask = async (): Promise<Answered> => {
		const request: ModelRequest = {
			system: config.system,
			messages: [...messages],
			tools: config.tools.map((tool) => tool.spec),
			signal,
		};
		if (config.modelName !== undefined) {
			request.model = config.modelName;
		}
		turns += 1;
		emit({ type: "turn_start", run: runId, ts: clock.now(), turn: turns });

		try {
			const answered = await config.model.complete(request);
			if (!answered.ok) {
				return {
					ok: false,
					error: { code: answered.error.code, message: answered.error.message },
				};
			}
			return { ok: true, reply: answered.value };
		} catch (error) {
			return { ok: false, error: { code: "internal", message: messageOf(error) } };
		}
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
				activeMs: clock.now() - activeSince,
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

			const answered = await ask();
			if (!answered.ok) {
				// An abort during the request is a person stopping the run, not the
				// model failing, so the signal is checked before the error is believed.
				const stoppedWhileAsking = stopped();
				if (stoppedWhileAsking !== undefined) {
					return stoppedWhileAsking;
				}
				emit({ type: "error", run: runId, ts: clock.now(), error: answered.error });
				return {
					reason: "failed",
					error: answered.error,
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
				return {
					reason: "parked",
					parkedReason: "stuck",
					usage: usageTotal.total(),
					turns,
				};
			}

			for (const call of calls) {
				emit({ type: "tool_call", run: runId, ts: clock.now(), call });
			}

			let finished = false;
			await executeTools({
				calls,
				tools: config.tools,
				clock,
				signal,
				deadlineMs,
				runId,
				isFinished: () => finished,
				onStart: (call) => {
					emit({
						type: "tool_start",
						run: runId,
						ts: clock.now(),
						callId: call.id,
						name: call.name,
					});
				},
				onFinish: async (call, outcome) => {
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
					if (outcome.done === true && !outcome.isError) {
						finished = true;
					}
				},
			});

			emit({
				type: "turn_end",
				run: runId,
				ts: clock.now(),
				turn: turns,
				finishReason: reply.finishReason,
			});
			if (finished) {
				// The run would end here, so this is where a person's follow-up is read.
				if (await readQueued("follow_up")) {
					continue;
				}
				return { reason: "done", usage: usageTotal.total(), turns };
			}
		}
	};

	let result: RunResult;
	try {
		// A task input is never truncated: half a request would be a different job,
		// so one that cannot fit is refused and nothing is saved (decision 90).
		const first: UserMessageEntry = {
			type: "user_message",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			label: "task",
			text: config.input,
		};
		const firstFits = utf8Length(encodeEntry(first)) <= entryCap;

		emit({ type: "run_start", run: runId, ts: clock.now(), task: config.task });

		const refused =
			checkedLimits !== undefined && !checkedLimits.ok ? checkedLimits.error : undefined;
		if (refused !== undefined) {
			emit({ type: "error", run: runId, ts: clock.now(), error: refused });
			result = { reason: "failed", error: refused, usage: usageTotal.total(), turns };
		} else if (!firstFits) {
			const error: LyraError = {
				code: "bad_request",
				message: `the task input is bigger than one record entry can hold (${entryCap} bytes)`,
			};
			emit({ type: "error", run: runId, ts: clock.now(), error });
			result = { reason: "failed", error, usage: usageTotal.total(), turns };
		} else {
			const header = encodeHeader({
				type: "header",
				v: RECORD_VERSION,
				run: runId,
				task: config.task,
				startedAt: clock.now(),
				host: config.host,
			});
			await save(header);
			recordStarted = true;

			await append(first);
			messages.push({ role: "user", text: first.text });
			await saveStatus("running");
			activeSince = clock.now();

			result = await loop();
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
		await saveStatus(
			result.reason === "done" ? "done" : result.reason === "parked" ? "parked" : "failed",
			result.reason === "parked" ? result.parkedReason : undefined,
			result.reason === "parked" ? result.parkedDetail : undefined,
		);
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
