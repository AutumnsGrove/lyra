/**
 * Time and identity, injected (docs/implementation/README.md, calls made in advance, 5).
 *
 * The core never reads the real clock and never draws its own randomness, so a
 * test can advance time by hand and the same script produces the same record
 * byte for byte. `core/system-clock.ts` is the one place that wraps the real
 * things, and it is only used by a host that has no better answer.
 */

export interface Clock {
	/** Milliseconds since the epoch. */
	now(): number;
	/**
	 * Wait, without blocking. Rejects if `signal` aborts first, so a stopped run
	 * does not finish its wait, and a test can move time instead of waiting.
	 */
	sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface Ids {
	/** A fresh identifier that begins with `prefix`, such as `c1` or `e_9f2a`. */
	next(prefix: string): string;
}
