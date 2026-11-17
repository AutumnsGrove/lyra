/**
 * Secrets in memory, for tests and for a host that has none to offer.
 *
 * A tool asks by name and gets a value or nothing; it never learns what else is
 * held (decision 12). Nothing here is logged, and nothing is written down, which
 * is what makes it safe for a test to hold a made-up key.
 */

import type { SecretsSlot } from "../../core/slots.js";

export interface MemorySecrets extends SecretsSlot {
	/** Put a value in place, so a test can change one between calls. */
	set(name: string, value: string): void;
}

export function memorySecrets(initial: Record<string, string> = {}): MemorySecrets {
	const held = new Map(Object.entries(initial));
	return {
		async get(name) {
			return held.get(name);
		},
		set(name, value) {
			held.set(name, value);
		},
	};
}
