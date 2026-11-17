/**
 * The one file allowed to touch the real clock and real randomness.
 *
 * `scripts/importcheck.mjs` fails any other production file under `src/` that
 * calls `Date.now`, `new Date(`, `setTimeout`, `setInterval`, `Math.random` or
 * `console.`, so time and ids are injected everywhere else and a test can
 * control them (docs/implementation/README.md, calls made in advance, 5).
 */

import type { Clock, Ids } from "./clock.js";

/** Bytes in an id's random half. 128 bits is what decision 85 wants for an unguessable id. */
const ID_BITS = 128;

/** A clock over the host's own time. Takes the real ones as arguments so this file is testable. */
function clockFrom(
	nowMs: () => number,
	wait: (callback: () => void, ms: number) => number,
	cancelWait: (handle: number) => void,
): Clock {
	return {
		now: nowMs,
		sleep(ms, signal) {
			return new Promise<void>((resolve, reject) => {
				if (signal?.aborted === true) {
					reject(aborted());
					return;
				}
				const handle = wait(() => {
					signal?.removeEventListener("abort", onAbort);
					resolve();
				}, ms);
				function onAbort(): void {
					cancelWait(handle);
					reject(aborted());
				}
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
	};
}

function aborted(): Error {
	const error = new Error("sleep aborted");
	error.name = "AbortError";
	return error;
}

/** The host's clock. Use it only where nothing better exists: a test injects a fake. */
export function systemClock(): Clock {
	return clockFrom(
		() => Date.now(),
		(callback, ms) => setTimeout(callback, ms),
		(handle) => clearTimeout(handle),
	);
}

/**
 * Ids from the platform's cryptographic random source, as hex. A prefix such as
 * `e` keeps a record readable; the random half is what cannot be guessed.
 */
export function systemIds(): Ids {
	return {
		next(prefix) {
			const bytes = crypto.getRandomValues(new Uint8Array(ID_BITS / 8));
			let hex = "";
			for (const byte of bytes) {
				hex += byte.toString(16).padStart(2, "0");
			}
			return `${prefix}_${hex}`;
		},
	};
}
