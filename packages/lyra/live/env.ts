/**
 * The live suite's only source of keys: the environment, by name.
 *
 * Nothing here writes a key anywhere, and nothing prints one. The Secrets slot
 * the adapter sees is this, so a live test exercises the same path a host would:
 * the adapter asks for `OPENROUTER_API_KEY` and gets the value or nothing.
 */

import type { SecretsSlot } from "../src/core/slots.ts";

export const liveSecrets: SecretsSlot = {
	get: async (name: string): Promise<string | undefined> => {
		const value = process.env[name];
		return value === undefined || value.trim() === "" ? undefined : value.trim();
	},
};

/**
 * Every key-shaped environment value, for the cassette scan. A recorded file is
 * refused when it holds one of these, whatever the pattern check would say.
 */
export function keyValues(): { name: string; value: string }[] {
	const entries: { name: string; value: string }[] = [];
	for (const [name, value] of Object.entries(process.env)) {
		if (value !== undefined && value.trim() !== "" && name.endsWith("_API_KEY")) {
			entries.push({ name, value: value.trim() });
		}
	}
	return entries;
}
