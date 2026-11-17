/**
 * Storage in memory (docs/adapters.md, "Spec rows: storage").
 *
 * A plain array of the lines as they were saved, which is enough for the loop,
 * the testkit and the scenarios in-process. It keeps the same promise the
 * Cloudflare adapter will: `seq` counts up from zero, a read is a copy, and a
 * line over the adapter's limit is refused without being stored.
 */

import { fail, ok } from "../../core/result.js";
import type { StorageSlot } from "../../core/slots.js";

/**
 * The record caps an entry at 1 MiB (decision 90), and this adapter's own limit
 * defaults to the same number: a line this small always saves, and a line bigger
 * than the record allows is not something the core will ask for.
 */
export const DEFAULT_MAX_LINE_BYTES = 1_048_576;

export interface MemoryStorageOptions {
	maxLineBytes?: number;
}

export interface MemoryStorage extends StorageSlot {
	/** The lines saved so far, as a copy, for a test that wants to look directly. */
	saved(): string[];
}

export function memoryStorage(options: MemoryStorageOptions = {}): MemoryStorage {
	const limit = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
	const encoder = new TextEncoder();
	const lines: string[] = [];

	return {
		saved: () => [...lines],

		async append(line) {
			const bytes = encoder.encode(line).length;
			if (bytes > limit) {
				return fail(
					"bad_request",
					`the line is ${bytes} bytes, over this storage's limit of ${limit}`,
				);
			}
			// The position is taken here, synchronously, so two appends issued without
			// waiting for the first cannot take the same `seq`.
			lines.push(line);
			return ok({ seq: lines.length - 1 });
		},

		async read() {
			return ok([...lines]);
		},
	};
}
