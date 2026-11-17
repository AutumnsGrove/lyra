/**
 * A clock a test drives (docs/engineering-practices.md, KIT01 and KIT05).
 *
 * Nothing here waits. A sleep says when it should end, and `advance` moves time
 * until it does, so a test of a five-minute deadline takes no time at all. When
 * a sleep is still waiting, `pending` says so, which is how a test catches a
 * timer that was scheduled and never resolved.
 */

import type { Clock } from "../core/clock.js";

/** The default start: 2023-11-14, an easy number to recognise in a record. */
export const FAKE_CLOCK_START = 1_700_000_000_000;

interface Waiting {
	at: number;
	resolve: () => void;
	reject: (error: Error) => void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

export interface FakeClock extends Clock {
	/** Move time forward, resolving everything due in the order it was due. */
	advance(ms: number): void;
	/** How many sleeps are still waiting. A test asserts this is zero at the end. */
	pending(): number;
}

function aborted(): Error {
	const error = new Error("sleep aborted");
	error.name = "AbortError";
	return error;
}

export function fakeClock(start = FAKE_CLOCK_START): FakeClock {
	let now = start;
	let nextId = 0;
	const waiting = new Map<number, Waiting>();

	const settle = (id: number, waitingFor: Waiting): void => {
		waiting.delete(id);
		if (waitingFor.signal !== undefined && waitingFor.onAbort !== undefined) {
			waitingFor.signal.removeEventListener("abort", waitingFor.onAbort);
		}
	};

	return {
		now: () => now,

		sleep(ms, signal) {
			if (signal?.aborted === true) {
				return Promise.reject(aborted());
			}
			// No deadline to wait for: the next turn of the microtask queue is enough,
			// and a zero delay in a script must not need an `advance` that never comes.
			if (ms <= 0) {
				return Promise.resolve();
			}
			return new Promise<void>((resolve, reject) => {
				const id = nextId;
				nextId += 1;
				const waitingFor: Waiting = { at: now + ms, resolve, reject };
				if (signal !== undefined) {
					waitingFor.signal = signal;
					waitingFor.onAbort = () => {
						settle(id, waitingFor);
						reject(aborted());
					};
					signal.addEventListener("abort", waitingFor.onAbort, { once: true });
				}
				waiting.set(id, waitingFor);
			});
		},

		advance(ms) {
			const target = now + ms;
			for (;;) {
				let due: [number, Waiting] | undefined;
				for (const [id, candidate] of waiting) {
					if (candidate.at > target) {
						continue;
					}
					if (due === undefined || candidate.at < due[1].at) {
						due = [id, candidate];
					}
				}
				if (due === undefined) {
					break;
				}
				const [id, waitingFor] = due;
				settle(id, waitingFor);
				now = waitingFor.at;
				waitingFor.resolve();
			}
			now = target;
		},

		pending: () => waiting.size,
	};
}
