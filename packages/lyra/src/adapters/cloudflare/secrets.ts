/**
 * Secrets over Worker bindings (docs/adapters.md, CFL19 to CFL21).
 *
 * A tool asks for a key by name and gets a string, or nothing. That is the whole
 * adapter: bindings are the host's, a non-string binding is not a secret (a KV
 * namespace or a Durable Object namespace is not text), and a name the object does
 * not own — including `__proto__` and `constructor` — is simply not held.
 *
 * The value never reaches a log, an error message or the record. A tool that needs
 * a missing secret gets `undefined` and says so by name; what a name maps to stays
 * in the host.
 */

import type { SecretsSlot } from "../../core/slots.js";

export function bindingSecrets(env: object): SecretsSlot {
	return {
		async get(name: string): Promise<string | undefined> {
			// An own property only, so a prototype name is a miss rather than a function,
			// and a descriptor so a non-string binding (a namespace, an object) is not a
			// secret rather than a surprise.
			const value = Object.getOwnPropertyDescriptor(env, name)?.value;
			return typeof value === "string" ? value : undefined;
		},
	};
}
