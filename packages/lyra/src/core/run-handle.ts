/**
 * A run's handle: how a person stops, steers or follows up on it (decisions 19,
 * 27; STP01 to STP05).
 *
 * `runTask` stays the primitive and this is the thing a host holds. The handle owns
 * the signal and the queues, so a command has somewhere to go between the
 * synchronous start of the run and its end:
 *
 * - `abort()` fires the run's own signal, which cancels the request in flight or
 *   the tool that is running; a second one is a no-op.
 * - `steer()` and `followUp()` are queued, never delivered on arrival, because
 *   writing a message between an assistant turn and its results would break the
 *   pairing a provider checks. The loop reads them at its gaps.
 *
 * Each queued text is measured against the record's entry cap when it is queued,
 * not when it is written, so an oversized one is refused with `bad_request` and
 * nothing is left half-queued. Its id and time are decided there too, so the
 * measurement is the real entry rather than an estimate.
 */

import { encodeEntry, type UserMessageEntry } from "../record/entries.js";
import { utf8Length } from "../record/truncate.js";
import type { RunEventListener } from "./events.js";
import { fail, ok, type Result } from "./result.js";
import {
	entryCapBytes,
	runTask,
	type QueuedMessage,
	type RunConfig,
	type RunControl,
	type RunResult,
} from "./run.js";

/** Everything a run needs except the two things the handle owns: the signal and the listener. */
export type RunSetup = Omit<RunConfig, "signal" | "onEvent" | "control">;

export interface RunHandle {
	readonly runId: string;
	/** Settles when the run has ended, with the result the loop reached. */
	readonly outcome: Promise<RunResult>;
	/** Stop the run. It parks as `stopped`, and a second abort does nothing. */
	abort(): void;
	/** Redirect the run at its next gap. Refused once it has ended. */
	steer(text: string): Result<void>;
	/** Say one more thing when the run would otherwise end. Refused once it has ended. */
	followUp(text: string): Result<void>;
	/** How many steers and follow-ups are waiting for the run's next gap. */
	pending(): { steers: number; followUps: number };
	/** Watch this run. The returned function stops watching. */
	subscribe(listener: RunEventListener): () => void;
}

/**
 * The longest id the core can make is 39 characters (128 bits as hex with a
 * prefix, decision 85), so a parent id is never longer than this placeholder.
 * Measuring the queued entry with one means a text that passes here cannot
 * overflow the entry when the real parent is linked in.
 */
const PARENT_PLACEHOLDER = "x".repeat(64);

export function createRun(setup: RunSetup): RunHandle {
	const controller = new AbortController();
	const cap = entryCapBytes(setup.storage, setup.entryCapBytes);
	const steers: QueuedMessage[] = [];
	const followUps: QueuedMessage[] = [];
	const listeners = new Set<RunEventListener>();
	let ended = false;

	const queue = (label: "steer" | "follow_up", text: string): Result<void> => {
		if (ended) {
			return fail("conflict", "the run has already ended");
		}
		const id = setup.ids.next("e");
		const entry: UserMessageEntry = {
			type: "user_message",
			id,
			parent: PARENT_PLACEHOLDER,
			ts: setup.clock.now(),
			label,
			text,
		};
		if (utf8Length(encodeEntry(entry)) > cap) {
			return fail(
				"bad_request",
				`the text is bigger than one record entry can hold (${cap} bytes)`,
			);
		}
		(label === "steer" ? steers : followUps).push({ id, ts: entry.ts, text });
		return ok(undefined);
	};

	const control: RunControl = {
		takeSteers: () => steers.splice(0, steers.length),
		takeFollowUps: () => followUps.splice(0, followUps.length),
	};

	const outcome = runTask({
		...setup,
		signal: controller.signal,
		control,
		onEvent: (event) => {
			// A listener is not allowed to be the reason a run fails (LOOP11), and one
			// that throws must not stop the others from hearing.
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					// Nothing to do: the loop already has the event.
				}
			}
		},
	});

	// The end is known when the loop's promise settles, which is after its closing
	// status is saved, so a command after that point has nothing to join.
	void outcome.then(
		() => {
			ended = true;
		},
		() => {
			ended = true;
		},
	);

	return {
		runId: setup.runId,
		outcome,
		abort: () => {
			controller.abort();
		},
		steer: (text) => queue("steer", text),
		followUp: (text) => queue("follow_up", text),
		pending: () => ({ steers: steers.length, followUps: followUps.length }),
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}
