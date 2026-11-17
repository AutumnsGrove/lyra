/**
 * Ids as counters, so the same script writes the same record twice
 * (`docs/core-loop.md`, "Time and identity are injected").
 *
 * This is not for a host that can be reached by anyone: an id that counts is
 * guessable, and decision 85 wants an unguessable one for an approval. A host
 * uses `systemIds`; a test uses these, because a record it can predict is a
 * record it can compare byte for byte.
 */

import type { Ids } from "../../core/clock.js";

export function counterIds(): Ids {
	const counters = new Map<string, number>();
	return {
		next(prefix) {
			const count = (counters.get(prefix) ?? 0) + 1;
			counters.set(prefix, count);
			return `${prefix}${count}`;
		},
	};
}
