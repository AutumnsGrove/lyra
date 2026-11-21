/**
 * A session: one record, the runs it holds, and the commands a client sends it
 * (docs/protocol.md, "Commands"; decisions 44 and 83).
 *
 * The transport does not exist here. A session takes a validated command and
 * answers with the response's data, so HTTP (step 6) and a WebSocket (step 8) are
 * thin layers over the same code, and a test can drive it without a socket.
 *
 * A session owns one record and therefore one run id: a follow-up or a resume
 * continues that run as a new segment, which is what the record's own header and
 * the runtime's resume check allow, and what decision 44 means by a session
 * holding many runs' worth of conversation. Only one run is ever being driven at
 * a time, so a second command that would start work is `busy` rather than a rival.
 *
 * Events come from the record whenever they can. A live run reports every entry it
 * saves, so the session reads the record and projects it after each one; what a
 * client sees is therefore exactly what a reconnect would replay, in the same
 * order, with the same `seq`, and the only events that travel live alone are the
 * ones the record does not hold (`retry`, `tool_start`). Reading the whole record
 * per write is the simple version; a long run reads a lot, and the note in
 * `docs/implementation/notes.md` says so.
 */

import type { Clock, Ids } from "../core/clock.js";
import { parkedReasonOf } from "../core/events.js";
import { isPlainObject, type JsonValue } from "../core/json.js";
import type { ModelSlot } from "../core/model.js";
import { fail, ok, type Result } from "../core/result.js";
import { DEFAULT_ENTRY_CAP_BYTES } from "../core/run.js";
import { readResumeSeed, type ResumeSeed } from "../core/resume.js";
import { createRuntime, type RunDefinition, type Runtime } from "../core/runtime.js";
import type { RunHandle } from "../core/run-handle.js";
import type { StorageSlot, WakingSlot } from "../core/slots.js";
import { createUsageTotal } from "../core/usage.js";
import type { RecordEntry } from "../record/entries.js";
import { loadRecord } from "../record/load.js";
import { activePath } from "../record/replay.js";
import { utf8Length } from "../record/truncate.js";
import type { Command } from "./commands.js";
import { eventsAfter, projectEvents, type RecordEvent } from "./events.js";

/** How many record entries one page of `get_messages` holds unless a client asks. */
const DEFAULT_PAGE_SIZE = 50;

/** An event that is never replayed, because the record does not hold it (decision 86). */
export interface LiveEventBase {
	ts: number;
	session: string;
	run: string;
}

export type SessionEvent =
	| RecordEvent
	| (LiveEventBase & { type: "retry"; attempt: number; delayMs: number })
	| (LiveEventBase & { type: "tool_start"; callId: string; name: string });

export interface SessionOptions {
	id: string;
	storage: StorageSlot;
	clock: Clock;
	ids: Ids;
	model: ModelSlot;
	host: string;
	/** Whose session this is, written on its record and refused to anyone else. */
	tenant?: string;
	/** The tasks this host runs, by name (docs/recipes-and-tools.md). */
	recipes: ReadonlyMap<string, RunDefinition>;
	modelName?: string;
	waking?: WakingSlot;
	/**
	 * The runtime to drive runs with. A host that must share one (a Durable Object's
	 * alarm resumes through the same registry) passes it, so a wake and a command
	 * cannot drive the same run twice.
	 */
	runtime?: Runtime;
	/** How many record entries one page of `get_messages` holds. */
	pageSize?: number;
	/** The most bytes one page of `get_messages` may reach, so a reply fits one line. */
	maxPageBytes?: number;
}

export interface Session {
	readonly id: string;
	/** Do one validated command, and answer with the response frame's data. */
	command(command: Command): Promise<Result<JsonValue>>;
	/** The events the record already holds after `seq`, in order. */
	replay(after: number): Promise<Result<SessionEvent[]>>;
	/** Replay, then follow the run as it grows. The returned function stops watching. */
	follow(after: number, listener: (event: SessionEvent) => void): Promise<Result<() => void>>;
	/** The host's alarm: continue the run it names, and watch it like any other. */
	wake(runId: string): Promise<Result<JsonValue>>;
}

/** A value this module built out of the record or its own answers, as response data. */
function data(value: unknown): JsonValue {
	return value as JsonValue;
}

/** JSON equality, because a client may send the same object with its keys in another order. */
function sameJson(left: JsonValue | undefined, right: JsonValue): boolean {
	if (left === undefined) {
		return false;
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => sameJson(value, right[index] as JsonValue))
		);
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		const keys = Object.keys(left);
		return (
			keys.length === Object.keys(right).length &&
			keys.every(
				(key) =>
					Object.prototype.hasOwnProperty.call(right, key) &&
					sameJson(left[key], right[key] as JsonValue),
			)
		);
	}
	return left === right;
}

interface Subscriber {
	/** The `seq` this client already has, so it is sent what it is missing and no more. */
	after: number;
	send: (event: SessionEvent) => void;
}

export function createSession(options: SessionOptions): Session {
	const runtime =
		options.runtime ??
		createRuntime({
			storage: options.storage,
			clock: options.clock,
			ids: options.ids,
			model: options.model,
			host: options.host,
			...(options.tenant === undefined ? {} : { tenant: options.tenant }),
			...(options.modelName === undefined ? {} : { modelName: options.modelName }),
			...(options.waking === undefined ? {} : { waking: options.waking }),
		});

	/**
	 * The run this session has started, remembered from the moment the command
	 * answers. The record is the truth, but its header is written a few awaits after
	 * `start` returns, so without this a second `start` interleaving in that window
	 * would read an empty record and start a rival run (found in review).
	 */
	let started: { task: string; input: JsonValue; runId: string } | undefined;

	const subscribers = new Set<Subscriber>();
	/** Events with no record entry behind them, waiting for the next turn of the pump. */
	let pendingLive: SessionEvent[] = [];
	/** One pump at a time, so record events and live events never overtake each other. */
	let chain: Promise<void> = Promise.resolve();

	const deliver = (subscriber: Subscriber, event: SessionEvent): void => {
		try {
			subscriber.send(event);
		} catch {
			// A listener is not allowed to break the session or starve the others.
		}
	};

	const pump = async (): Promise<void> => {
		if (subscribers.size === 0) {
			pendingLive = [];
			return;
		}
		const read = await options.storage.read();
		if (read.ok && read.value.length > 0) {
			const loaded = loadRecord(read.value);
			if (loaded.ok) {
				const events = projectEvents(loaded.value.entries, {
					session: options.id,
					run: loaded.value.header.run,
				});
				for (const subscriber of subscribers) {
					for (const event of eventsAfter(events, subscriber.after)) {
						if (!subscribers.has(subscriber)) {
							break;
						}
						deliver(subscriber, event);
						subscriber.after = event.seq;
					}
				}
			}
		}
		const live = pendingLive;
		pendingLive = [];
		for (const event of live) {
			for (const subscriber of subscribers) {
				deliver(subscriber, event);
			}
		}
	};

	const schedule = (): void => {
		chain = chain.then(pump).catch(() => undefined);
	};

	/** Watch a run this session is driving, so its writes reach the clients. */
	const listen = (handle: RunHandle): void => {
		handle.subscribe((event) => {
			if (event.type === "retry") {
				pendingLive.push({
					type: "retry",
					ts: event.ts,
					session: options.id,
					run: handle.runId,
					attempt: event.attempt,
					delayMs: event.delayMs,
				});
			} else if (event.type === "tool_start") {
				pendingLive.push({
					type: "tool_start",
					ts: event.ts,
					session: options.id,
					run: handle.runId,
					callId: event.callId,
					name: event.name,
				});
			}
			schedule();
		});
	};

	/** The record, when there is one: what a command is about. */
	const seedOf = async (): Promise<Result<ResumeSeed | undefined>> => {
		const read = await options.storage.read();
		if (!read.ok) {
			return read;
		}
		if (read.value.length === 0) {
			return ok(undefined);
		}
		const seed = readResumeSeed(read.value);
		if (!seed.ok) {
			return fail(
				"internal",
				`this session's record could not be read: ${seed.error.message}`,
			);
		}
		return ok(seed.value);
	};

	const otherSession = (session: string): Result<never> =>
		fail("not_found", `there is no session ${session} here`);

	/** A message that continues the record without starting a rival run. */
	const continueWith = async (seed: ResumeSeed, text: string): Promise<Result<JsonValue>> => {
		const header = seed.record.header;
		const definition = options.recipes.get(header.task);
		if (definition === undefined) {
			return fail(
				"not_found",
				`this session's task "${header.task}" is not one this host runs`,
			);
		}
		const resumed = await runtime.resume({
			runId: header.run,
			task: header.task,
			definition,
			by: "person",
			followUp: text,
		});
		if (!resumed.ok) {
			return resumed;
		}
		listen(resumed.value);
		return ok(data({ session: options.id, run: header.run }));
	};

	const getState = (seed: ResumeSeed | undefined): JsonValue => {
		const header = seed?.record.header;
		const status = seed?.status;
		const usage = createUsageTotal();
		for (const used of seed?.usages ?? []) {
			usage.add(used);
		}
		const handle = header === undefined ? undefined : runtime.active(header.run);
		const queue = handle?.pending() ?? { steers: 0, followUps: 0 };
		const state =
			status === undefined ? "idle" : status.state === "resumed" ? "running" : status.state;
		const parked =
			status?.state === "parked"
				? {
						reason: parkedReasonOf(status.reason),
						...(status.detail === undefined ? {} : { detail: status.detail }),
					}
				: undefined;
		return data({
			session: options.id,
			run: header?.run ?? null,
			state,
			...(parked === undefined ? {} : { parked }),
			turns: seed?.turns ?? 0,
			usage: usage.total(),
			queue,
			// Approvals arrive in a later slice, so nothing is waiting for a person yet.
			pending: 0,
		});
	};

	const getMessages = (
		command: Extract<Command, { command: "get_messages" }>,
		seed: ResumeSeed,
	) => {
		const path = activePath(seed.record.entries);
		let branch = path;
		if (command.entry !== undefined) {
			const index = path.findIndex((entry) => entry.id === command.entry);
			if (index < 0) {
				return fail("bad_request", `this record has no entry ${command.entry}`);
			}
			branch = path.slice(0, index + 1);
		}
		let start = 0;
		if (command.cursor !== undefined) {
			const index = branch.findIndex((entry) => entry.id === command.cursor);
			if (index < 0) {
				return fail("bad_request", `this branch has no entry ${command.cursor}`);
			}
			start = index + 1;
		}

		// A page is capped in entries and in bytes, so a long record can never make a
		// reply that is over the line cap (CMD12).
		const pageSize = command.limit ?? options.pageSize ?? DEFAULT_PAGE_SIZE;
		const maxBytes = options.maxPageBytes ?? DEFAULT_ENTRY_CAP_BYTES;
		const entries: RecordEntry[] = [];
		let bytes = 0;
		for (let index = start; index < branch.length; index += 1) {
			const entry = branch[index] as RecordEntry;
			const size = utf8Length(JSON.stringify(entry));
			if (entries.length > 0 && (entries.length >= pageSize || bytes + size > maxBytes)) {
				break;
			}
			entries.push(entry);
			bytes += size;
		}
		const more = start + entries.length < branch.length;
		const cursor = more ? (entries.at(-1)?.id ?? null) : null;
		return ok(data({ session: options.id, run: seed.record.header.run, entries, cursor }));
	};

	return {
		id: options.id,

		replay: async (after) => {
			const read = await options.storage.read();
			if (!read.ok) {
				return read;
			}
			if (read.value.length === 0) {
				return ok([]);
			}
			const loaded = loadRecord(read.value);
			if (!loaded.ok) {
				return fail(
					"internal",
					`this session's record could not be read: ${loaded.error.message}`,
				);
			}
			const events = projectEvents(loaded.value.entries, {
				session: options.id,
				run: loaded.value.header.run,
			});
			return ok(eventsAfter(events, after));
		},

		wake: async (runId) => {
			const existing = await seedOf();
			if (!existing.ok) {
				return existing;
			}
			const seed = existing.value;
			if (seed === undefined) {
				return fail("not_found", "this session has no record to wake");
			}
			const header = seed.record.header;
			if (header.run !== runId) {
				return fail("not_found", `this session does not hold run ${runId}`);
			}
			const definition = options.recipes.get(header.task);
			if (definition === undefined) {
				return fail(
					"not_found",
					`this session's task "${header.task}" is not one this host runs`,
				);
			}
			const woken = await runtime.wake({ runId, task: header.task, definition });
			if (!woken.ok) {
				return woken;
			}
			listen(woken.value);
			return ok(data({ session: options.id, run: runId }));
		},

		follow: async (after, listener) => {
			const subscriber: Subscriber = { after, send: listener };
			subscribers.add(subscriber);
			// The replay happens inside the pump, so a client cannot be sent a live
			// event before the record events that came before it.
			schedule();
			await chain;
			return ok(() => {
				subscribers.delete(subscriber);
			});
		},

		command: async (command) => {
			if (
				"session" in command &&
				command.session !== undefined &&
				command.session !== options.id
			) {
				return otherSession(command.session);
			}

			if (command.command === "start") {
				const existing = await seedOf();
				if (!existing.ok) {
					return existing;
				}
				// Checked after the read and before anything that awaits, so two starts
				// that both passed the read cannot both get past here.
				const inFlight = started;
				if (inFlight !== undefined) {
					if (command.key === undefined) {
						return fail(
							"conflict",
							"this session is already running a task; a prompt or a follow_up continues it",
						);
					}
					if (
						inFlight.task !== command.task ||
						!sameJson(inFlight.input, command.input)
					) {
						return fail(
							"conflict",
							"that key belongs to a run with a different task or input",
						);
					}
					return ok(data({ session: options.id, run: inFlight.runId }));
				}
				if (existing.value !== undefined) {
					const header = existing.value.record.header;
					if (command.key === undefined) {
						return fail(
							"conflict",
							"this session is already running a task; a prompt or a follow_up continues it",
						);
					}
					if (
						header.task !== command.task ||
						!sameJson(existing.value.input, command.input)
					) {
						return fail(
							"conflict",
							"that key belongs to a run with a different task or input",
						);
					}
					return ok(data({ session: options.id, run: header.run }));
				}
				const definition = options.recipes.get(command.task);
				if (definition === undefined) {
					return fail("not_found", `there is no task called "${command.task}"`);
				}
				const runId = options.ids.next("r");
				const beginning = runtime.start({
					runId,
					task: command.task,
					input: command.input,
					definition,
				});
				if (!beginning.ok) {
					return beginning;
				}
				// From here to the return is synchronous, so no second start can pass the
				// check above until this one has claimed the session.
				started = { task: command.task, input: command.input, runId };
				listen(beginning.value);
				return ok(data({ session: options.id, run: runId }));
			}

			const existing = await seedOf();
			if (!existing.ok) {
				return existing;
			}
			const seed = existing.value;

			if (command.command === "get_state") {
				return ok(getState(seed));
			}
			if (seed === undefined) {
				return fail("not_found", "this session has no record yet");
			}
			const header = seed.record.header;
			const active = runtime.active(header.run);

			switch (command.command) {
				case "get_messages":
					return getMessages(command, seed);
				case "prompt":
				case "follow_up": {
					if (active !== undefined) {
						if (command.command === "prompt" && !command.queue) {
							return fail("busy", "a run is active in this session");
						}
						const queued = active.followUp(command.text);
						if (!queued.ok) {
							return queued;
						}
						return ok(data({ session: options.id, run: header.run }));
					}
					return continueWith(seed, command.text);
				}
				case "steer": {
					if (active === undefined) {
						return fail("conflict", "nothing is running in this session");
					}
					const steered = active.steer(command.text);
					if (!steered.ok) {
						return steered;
					}
					return ok(data({ session: options.id, run: header.run }));
				}
				case "abort": {
					if (active === undefined) {
						return fail("conflict", "nothing is running in this session");
					}
					active.abort();
					return ok(data({ session: options.id, run: header.run }));
				}
				case "resume": {
					if (active !== undefined) {
						return fail("busy", "a run is already active in this session");
					}
					const definition = options.recipes.get(header.task);
					if (definition === undefined) {
						return fail(
							"not_found",
							`this session's task "${header.task}" is not one this host runs`,
						);
					}
					const resumed = await runtime.resume({
						runId: header.run,
						task: header.task,
						definition,
						by: "person",
					});
					if (!resumed.ok) {
						return resumed;
					}
					listen(resumed.value);
					return ok(data({ session: options.id, run: header.run }));
				}
			}
		},
	};
}
