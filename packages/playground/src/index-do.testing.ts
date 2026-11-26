/**
 * A conversation index over a `Map`, for tests (issue #60, slice 3).
 *
 * It is the same shape as the object's own storage, so a test that rebuilds the index
 * over the same map is asking what an eviction asks. Kept out of `index-do.test.ts` so
 * the Worker's tests drive the real object over the same fake rather than a second one.
 */

import type { IndexStorage } from "./index-do.js";

export function memoryIndex(): { storage: IndexStorage; map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	const storage: IndexStorage = {
		async get(key) {
			return map.get(key);
		},
		async put(key, value) {
			map.set(key, value);
		},
		async list(options) {
			const prefix = options?.prefix ?? "";
			const found = new Map<string, unknown>();
			for (const [key, value] of map) {
				if (key.startsWith(prefix)) {
					found.set(key, value);
				}
			}
			return found;
		},
	};
	return { storage, map };
}
