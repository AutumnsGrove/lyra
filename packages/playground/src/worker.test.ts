import { expect, test } from "vitest";

import type {
	DurableObjectNamespaceLike,
	DurableObjectStubLike,
} from "@autumnsgrove/lyra/cloudflare";

import { tokensFrom, type Env } from "./session.js";
import worker, { Session } from "./worker.js";

/**
 * The rows are in `docs/playground.md`: PGS01.
 *
 * The subject is the Worker's own `fetch` and the bindings it reads, not the adapter's
 * router underneath it: the tenant a token maps to, the object name that comes out,
 * and the fact that a refusal never wakes an object.
 */

const TOKEN = "a-playground-token-for-a-test";

interface Recorded {
	namespace: DurableObjectNamespaceLike;
	forwarded: string[];
	/** Every object name the Worker derived, which is where the tenant shows. */
	names: string[];
}

function recordingNamespace(): Recorded {
	const forwarded: string[] = [];
	const names: string[] = [];
	const stub: DurableObjectStubLike = {
		fetch: async (request) => {
			forwarded.push(`${request.method} ${new URL(request.url).pathname}`);
			return new Response("{}", { status: 200 });
		},
	};
	const namespace: DurableObjectNamespaceLike = {
		idFromName: (name) => {
			names.push(name);
			return { toString: () => name };
		},
		idFromString: (hex) => ({ toString: () => hex }),
		newUniqueId: () => ({ toString: () => "unique" }),
		get: () => stub,
	};
	return { namespace, forwarded, names };
}

/**
 * The bindings a deployment has. `SESSION` is the recording namespace so a forwarded
 * request can be seen; the token and tenant are the two the Worker's door reads.
 */
function env(namespace: DurableObjectNamespaceLike): Env {
	return {
		SESSION: namespace as unknown as DurableObjectNamespace,
		PLAYGROUND_TOKEN: TOKEN,
		PLAYGROUND_TENANT: "playground",
	};
}

function startFrame(): string {
	return JSON.stringify({
		type: "command",
		id: "c1",
		command: "start",
		task: "shell",
		input: "say hello",
		key: "k1",
	});
}

test("PGS01 a command without the token is refused, and no object is woken", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const response = await worker.fetch(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			body: startFrame(),
		}),
		env(namespace),
	);

	// 403 is what the command surface answers for an unknown or missing token (HTP02),
	// and the object must not be woken for a request the Worker already refused.
	expect(response.status).toBe(403);
	const body = (await response.json()) as { error?: { code?: string } };
	expect(body.error?.code).toBe("permission_denied");
	expect(forwarded).toEqual([]);
});

test("PGS01 a wrong token is refused, and no object is woken", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const response = await worker.fetch(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			// A token of the right shape against a deployment whose secret is set: the one
			// case a door that compared nothing would accept.
			headers: { authorization: "Bearer not-the-token" },
			body: startFrame(),
		}),
		env(namespace),
	);

	expect(response.status).toBe(403);
	const body = (await response.json()) as { error?: { code?: string } };
	expect(body.error?.code).toBe("permission_denied");
	expect(forwarded).toEqual([]);
});

test("PGS01 a command with the token reaches the object for the token's tenant", async () => {
	const { namespace, forwarded, names } = recordingNamespace();
	const response = await worker.fetch(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: startFrame(),
		}),
		env(namespace),
	);

	expect(response.status).toBe(200);
	expect(forwarded).toEqual(["POST /v1/commands"]);
	// The object name carries the tenant the token resolved to, so a token paired with
	// the wrong tenant would put this run in someone else's session and fail here.
	expect(names).toEqual(["playground:k1"]);
});

test("PGS01 an unknown /v1 route is a refusal, and wakes no object", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const response = await worker.fetch(
		new Request("https://playground.test/v1/nothing-here", {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
		env(namespace),
	);

	// `/v1/*` is the prefix the Worker claims, so an unknown path under it is a refusal
	// rather than the page. A path outside `/v1` never reaches this function at all: the
	// assets answer it, or the single-page fallback does.
	expect(response.status).toBe(404);
	expect(forwarded).toEqual([]);
});

test("PGS01 the entry point exports the session class under the name the config binds", () => {
	// `class_name` in `wrangler.jsonc` is resolved against this entry module's exports, so
	// a rename or a lost re-export is a deploy that uploads and then fails. The class is
	// not constructed here: its own delegation to the adapter needs workerd, and that is
	// slice 2's test, where a session has a real model to talk to.
	expect(typeof Session).toBe("function");
	expect(Session.name).toBe("Session");
});

test("PGS01 a deployment with no secret binds no tenant, and no request authenticates", async () => {
	// The secret is created by `wrangler secret put`, so a deployment can answer a request
	// before anyone set it. An empty token would otherwise be a digest the door holds for
	// "", which is a credential nobody chose; `tokensFrom` binds no tenant in either case.
	//
	// The `tokensFrom` assertion is the one that can fail on that bug: `Headers` trims the
	// space off a bare `Bearer`, so the door never sees an empty token and would refuse
	// this request either way. The request assertions are here for the claim a person
	// cares about — nothing authenticates against a deployment whose secret is unset —
	// not as a probe of the digest.
	for (const token of [undefined, ""]) {
		// The map itself, which is what the door is built from: no tenant, no digest.
		expect(
			tokensFrom({ ...env(recordingNamespace().namespace), PLAYGROUND_TOKEN: token }),
		).toEqual({});

		const { namespace, forwarded } = recordingNamespace();
		const response = await worker.fetch(
			new Request("https://playground.test/v1/commands", {
				method: "POST",
				headers: { authorization: "Bearer   " },
				body: startFrame(),
			}),
			{ ...env(namespace), PLAYGROUND_TOKEN: token },
		);

		expect(response.status, `token ${JSON.stringify(token)}`).toBe(403);
		const body = (await response.json()) as { error?: { code?: string } };
		expect(body.error?.code).toBe("permission_denied");
		expect(forwarded).toEqual([]);
	}
});

test("PGS01 an empty or missing tenant binds nothing either", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const response = await worker.fetch(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: startFrame(),
		}),
		{ ...env(namespace), PLAYGROUND_TENANT: "" },
	);
	expect(tokensFrom({ ...env(namespace), PLAYGROUND_TENANT: "" })).toEqual({});

	// The token would otherwise be filed under the empty tenant, which is a session name
	// no request can address; refusing is what the object would do anyway (409/403), and
	// the Worker should not wake an object to find that out.
	expect(response.status).toBe(403);
	expect(forwarded).toEqual([]);
});
