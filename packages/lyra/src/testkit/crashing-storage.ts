/**
 * Storage whose host dies at one append (docs/engineering-practices.md, KIT07).
 *
 * A kill is not an error: if the append threw, the "dead" run's error handler would
 * keep writing and keep running tools, which is the opposite of a killed process.
 * So the chosen append returns a promise that never settles — without writing the
 * line for `before`, once the line is persisted for `after` — and the abandoned run
 * is frozen there for good. The test never awaits that run; it hands the wrapped
 * storage to a fresh one and resumes.
 */

import type { StorageSlot } from "../core/slots.js";
import type { Result } from "../core/result.js";

export interface CrashingStorageOptions {
	/** Which append dies, counting from one. */
	at: number;
	/** `before` dies with nothing saved; `after` dies once the line is saved. */
	when: "before" | "after";
}

export interface CrashingStorage extends StorageSlot {
	/** Appends that reached the wrapped adapter. */
	appends(): number;
}

/** A promise that never settles: the shape of a process that is no longer there. */
function never<T>(): Promise<T> {
	return new Promise<T>(() => {
		// Deliberately empty: nothing can resolve this, which is the point.
	});
}

export function crashingStorage(
	inner: StorageSlot,
	options: CrashingStorageOptions,
): CrashingStorage {
	let attempted = 0;

	return {
		appends: () => attempted,
		// The inner adapter's own limit is the one that matters, so a crash wrapper
		// never changes what the core thinks it can save.
		...(inner.maxEntryBytes === undefined ? {} : { maxEntryBytes: inner.maxEntryBytes }),

		async append(line: string): Promise<Result<{ seq: number }>> {
			attempted += 1;
			if (attempted === options.at) {
				if (options.when === "after") {
					await inner.append(line);
				}
				return never<Result<{ seq: number }>>();
			}
			return inner.append(line);
		},

		async read() {
			return inner.read();
		},
	};
}
