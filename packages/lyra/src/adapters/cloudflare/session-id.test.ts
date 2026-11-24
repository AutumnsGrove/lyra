import { expect, test } from "vitest";

import { sessionIdFor, type DurableObjectNamespaceLike } from "./session.js";

/**
 * Which object a keyed `start` lands on. The name is built from the tenant and the
 * caller's own key, and a client picks its key freely, so two different pairs must
 * never produce one name: that would let a client park a key on another tenant's
 * object. The namespace here records the names it is asked for, which is all the
 * mapping is.
 */

function recordingNamespace(): { namespace: DurableObjectNamespaceLike; names: string[] } {
	const names: string[] = [];
	const namespace: DurableObjectNamespaceLike = {
		idFromName: (name) => {
			names.push(name);
			return { toString: () => name };
		},
		idFromString: (hex) => ({ toString: () => hex }),
		newUniqueId: () => ({ toString: () => "unique" }),
		get: () => ({ fetch: async () => new Response(null) }),
	};
	return { namespace, names };
}

function nameFor(tenant: string, key: string): string {
	const { namespace, names } = recordingNamespace();
	const id = sessionIdFor(namespace, { tenant, key });
	expect(id.ok).toBe(true);
	return names[0] ?? "";
}

test("a tenant with no colon keeps the name `<tenant>:<key>` it has always had", () => {
	// A retried key after an upgrade has to reach the object the first try made.
	expect(nameFor("grove", "daily:2026-11-24")).toBe("grove:daily:2026-11-24");
});

test("a tenant whose name holds a colon cannot collide with another tenant's key", () => {
	// `a` with key `b:c` and `a:b` with key `c` both read `a:b:c` when joined naively.
	expect(nameFor("a", "b:c")).not.toBe(nameFor("a:b", "c"));
	// And escaping must itself be unambiguous: a literal escape sequence is not a colon.
	expect(nameFor("a%3Ab", "c")).not.toBe(nameFor("a:b", "c"));
});
