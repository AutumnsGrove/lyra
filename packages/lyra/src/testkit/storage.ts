/**
 * Storage that fails on purpose (docs/engineering-practices.md, KIT04).
 *
 * A save that fails is the case that decides whether a run ends cleanly or loses
 * its record halfway, so it has to be reachable without a broken host. This wraps
 * any adapter and fails exactly one append, chosen by a test.
 */

import { fail } from "../core/result.js";
import type { StorageSlot } from "../core/slots.js";

export interface FailingStorageOptions {
	/** Which append fails, counting from one. Every other append is passed through. */
	failOn: number;
}

export interface FailingStorage extends StorageSlot {
	/** Appends attempted so far, including the failed one. */
	appends(): number;
}

export function failingStorage(inner: StorageSlot, options: FailingStorageOptions): FailingStorage {
	let attempted = 0;

	return {
		appends: () => attempted,

		async append(line) {
			attempted += 1;
			if (attempted === options.failOn) {
				// Nothing reaches the wrapped adapter, so nothing is stored: a failed save
				// cannot leave half a line behind (decision 20).
				return fail("internal", `the scripted storage failed on append ${attempted}`);
			}
			return inner.append(line);
		},

		async read() {
			return inner.read();
		},
	};
}
