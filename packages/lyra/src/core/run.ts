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
import type { ModelReply, ModelRequest, ModelSlot, ToolCall, Usage } from "./model.js";
import type { LyraError } from "./result.js";
import type { StorageSlot } from "./slots.js";
import type { Tool, ToolOutcome } from "./tool.js";
import {
	RECORD_VERSION,
	encodeEntry,
	encodeHeader,
	type AssistantMessageEntry,
	type RecordEntry,
	type StatusEntry,
	type ToolMessageEntry,
	type UserMessageEntry,
} from "../record/entries.js";

/** Five minutes, per docs/implementation/01-core-with-fakes.md, "Judgment calls already made". */
export const DEFAULT_TOOL_DEADLINE_MS = 300_000;

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
	toolDeadlineMs?: number;
	signal?: AbortSignal;
	onEvent?: RunEventListener;
}

export interface RunResult {
	reason: RunEndReason;
	parkedReason?: ParkedReason;
	/** Summed over every reply. Cost is only carried when every reply reported one. */
	usage: Usage;
	/** How many times the model was asked. */
	turns: number;
	error?: LyraError;
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
 */
function createUsageTotal() {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost: Usage["cost"] | undefined;
	let costKnown = true;

	return {
		add(next: Usage): void {
			inputTokens += next.inputTokens;
			outputTokens += next.outputTokens;
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
	};
}

export async function runTask(config: RunConfig): Promise<RunResult> {
	const clock = config.clock;
	const runId = config.runId;
	const deadlineMs = config.toolDeadlineMs ?? DEFAULT_TOOL_DEADLINE_MS;
	const signal = config.signal ?? new AbortController().signal;

	const messages: ConversationMessage[] = [];
	const tools = new Map<string, Tool>(config.tools.map((tool) => [tool.spec.name, tool]));

	let live = true;
	const usageTotal = createUsageTotal();
	let turns = 0;
	/** The id of the entry before the next one, which is what `parent` records. */
	let parent: string | null = null;

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
		const seq = await save(encodeEntry(entry));
		parent = entry.id;
		return seq;
	};

	const saveStatus = async (state: StatusEntry["state"], reason?: string): Promise<number> => {
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
		return append(entry);
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

	const loop = async (): Promise<RunResult> => {
		for (;;) {
			const stoppedBeforeAsking = stopped();
			if (stoppedBeforeAsking !== undefined) {
				return stoppedBeforeAsking;
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
				toolCalls: reply.toolCalls,
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
				toolCalls: reply.toolCalls,
			});

			const assistant: ConversationMessage =
				reply.reasoning === undefined
					? { role: "assistant", text: reply.text, toolCalls: reply.toolCalls }
					: {
							role: "assistant",
							text: reply.text,
							reasoning: reply.reasoning,
							toolCalls: reply.toolCalls,
						};
			messages.push(assistant);

			// A reply cut off by the token limit can hold half-written arguments, so
			// none of its calls run: each is answered with an error and the model is
			// asked again (decision 25).
			if (reply.finishReason === "length" && reply.toolCalls.length > 0) {
				for (const call of reply.toolCalls) {
					emit({ type: "tool_call", run: runId, ts: clock.now(), seq, call });
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

			if (reply.toolCalls.length === 0) {
				// No tool call and no `finish`: the model has stopped without saying the
				// job is done. Step 2 replaces this with reminders and a count.
				emit({
					type: "turn_end",
					run: runId,
					ts: clock.now(),
					turn: turns,
					finishReason: reply.finishReason,
				});
				return {
					reason: "parked",
					parkedReason: "stuck",
					usage: usageTotal.total(),
					turns,
				};
			}

			for (const call of reply.toolCalls) {
				emit({ type: "tool_call", run: runId, ts: clock.now(), seq, call });
			}

			let finished = false;
			await executeTools({
				calls: reply.toolCalls,
				tools: config.tools,
				clock,
				ids: config.ids,
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
				return { reason: "done", usage: usageTotal.total(), turns };
			}
		}
	};

	let result: RunResult;
	try {
		emit({ type: "run_start", run: runId, ts: clock.now(), task: config.task });

		const header = encodeHeader({
			type: "header",
			v: RECORD_VERSION,
			run: runId,
			task: config.task,
			startedAt: clock.now(),
			host: config.host,
		});
		await save(header);

		const first: UserMessageEntry = {
			type: "user_message",
			id: config.ids.next("e"),
			parent,
			ts: clock.now(),
			label: "task",
			text: config.input,
		};
		await append(first);
		messages.push({ role: "user", text: first.text });
		await saveStatus("running");

		result = await loop();
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
				}
			: { type: "run_end", run: runId, ts: clock.now(), reason: result.reason },
	);
	return result;
}
