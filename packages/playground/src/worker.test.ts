import { expect, test } from "vitest";

import type {
	DurableObjectNamespaceLike,
	DurableObjectStubLike,
} from "@autumnsgrove/lyra/cloudflare";

import { fakeClock } from "@autumnsgrove/lyra/testkit";

import { memoryIndex } from "./index-do.testing.js";
import { SessionIndex } from "./index-do.js";
import { recipeCatalogue } from "./recipes/catalogue.js";
import { sessionOptions, tokensFrom, type Env } from "./session.js";
import worker, { frontDoor, Session } from "./worker.js";

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
	let minted = 0;
	const namespace: DurableObjectNamespaceLike = {
		idFromName: (name) => {
			names.push(name);
			return { toString: () => name };
		},
		idFromString: (hex) => ({ toString: () => hex }),
		// Each mint is a new id, which is what the platform does: a fake that answered one
		// would let two conversations share an object and hide the collision.
		newUniqueId: () => ({ toString: () => `unique-${(minted += 1)}` }),
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
		// The sidebar's object: the `/v1` rows never reach it, and the `/api` rows replace
		// it with an index the test can read back.
		INDEX: namespace as unknown as DurableObjectNamespace,
		LYRA_PLAYGROUND_TOKEN: TOKEN,
		LYRA_PLAYGROUND_TENANT: "playground",
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
			tokensFrom({ ...env(recordingNamespace().namespace), LYRA_PLAYGROUND_TOKEN: token }),
		).toEqual({});

		const { namespace, forwarded } = recordingNamespace();
		const response = await worker.fetch(
			new Request("https://playground.test/v1/commands", {
				method: "POST",
				headers: { authorization: "Bearer   " },
				body: startFrame(),
			}),
			{ ...env(namespace), LYRA_PLAYGROUND_TOKEN: token },
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
		{ ...env(namespace), LYRA_PLAYGROUND_TENANT: "" },
	);
	expect(tokensFrom({ ...env(namespace), LYRA_PLAYGROUND_TENANT: "" })).toEqual({});

	// The token would otherwise be filed under the empty tenant, which is a session name
	// no request can address; refusing is what the object would do anyway (409/403), and
	// the Worker should not wake an object to find that out.
	expect(response.status).toBe(403);
	expect(forwarded).toEqual([]);
});

/**
 * The playground's own routes, which are the sidebar's whole data source.
 *
 * Rows PGS11 to PGS15 live in `docs/playground.md`. These drive a recording namespace
 * for the sessions, so the id the index is given and the id the page is told are the
 * same string, and the real `SessionIndex` over a `Map`, so the Worker's own decoding
 * and the object's promises are tested together rather than against a stub of both.
 */

interface Indexed {
	namespace: DurableObjectNamespaceLike;
	index: SessionIndex;
	/** Every object name the Worker derived, which is where the tenant shows. */
	names: string[];
}

function indexedNamespace(name = "unique"): Indexed {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });
	const names: string[] = [];
	// Each mint is a new conversation, the way the platform's own ids are: a fake that
	// answered one id would make two conversations overwrite each other, which is the
	// bug the sidebar's ordering test would then never see.
	let minted = 0;
	const namespace: DurableObjectNamespaceLike = {
		idFromName: (objectName) => {
			names.push(objectName);
			return { toString: () => objectName };
		},
		idFromString: (hex) => ({ toString: () => hex }),
		newUniqueId: () => ({ toString: () => `${name}-${(minted += 1)}` }),
		get: () => ({
			fetch: async (request) => index.fetch(request),
		}),
	};
	return { namespace, index, names };
}

function apiEnv(index: DurableObjectNamespaceLike, sessions?: DurableObjectNamespaceLike): Env {
	return {
		...env(sessions ?? recordingNamespace().namespace),
		INDEX: index as unknown as DurableObjectNamespace,
	};
}

function api(
	path: string,
	init: { method?: string; body?: unknown; token?: string } = {},
): Request {
	return new Request(`https://playground.test${path}`, {
		method: init.method ?? "GET",
		headers: init.token === undefined ? {} : { authorization: `Bearer ${init.token}` },
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	});
}

test("PGS11 a new conversation is minted, indexed under the tenant, and handed back", async () => {
	const sessions = indexedNamespace("session-abc");
	const index = indexedNamespace();
	const response = await worker.fetch(
		api("/api/sessions", {
			method: "POST",
			token: TOKEN,
			body: { recipe: "tool-table", label: "  What time is it?  " },
		}),
		apiEnv(index.namespace, sessions.namespace),
	);

	expect(response.status).toBe(201);
	// The id the page is told is the one the index was given, which is what the `start`
	// that follows will name. A page handed a second id would start a run nobody's
	// sidebar lists.
	expect(await response.json()).toEqual({ session: "session-abc-1" });
	expect(index.names).toEqual(["playground"]);
	const listed = await index.index.list();
	expect(listed).toHaveLength(1);
	expect(listed[0]).toMatchObject({ session: "session-abc-1", recipe: "tool-table" });
});

test("PGS11 a conversation is refused before anything is written", async () => {
	const index = indexedNamespace();

	// No token: the index must not be woken for a request the door already refused.
	const refused = await worker.fetch(
		api("/api/sessions", { method: "POST", body: { recipe: "shell", label: "x" } }),
		apiEnv(index.namespace),
	);
	expect(refused.status).toBe(403);
	expect(index.names).toEqual([]);

	// A recipe this Worker does not run, and a body it cannot read: both are refusals,
	// and neither leaves a conversation that every later `start` would fail to run.
	const unknown = await worker.fetch(
		api("/api/sessions", {
			method: "POST",
			token: TOKEN,
			body: { recipe: "no-such-recipe", label: "x" },
		}),
		apiEnv(index.namespace),
	);
	expect(unknown.status).toBe(404);
	expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");

	const malformed = await worker.fetch(
		api("/api/sessions", { method: "POST", token: TOKEN, body: { recipe: "shell" } }),
		apiEnv(index.namespace),
	);
	expect(malformed.status).toBe(400);

	const notJson = await worker.fetch(
		new Request("https://playground.test/api/sessions", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: "{",
		}),
		apiEnv(index.namespace),
	);
	expect(notJson.status).toBe(400);

	expect(await index.index.list()).toEqual([]);
});

test("PGS12 the sidebar lists conversations newest first, through the Worker", async () => {
	const index = indexedNamespace();
	// A clock the test owns, so "newest" is an assertion rather than a fast machine.
	let now = 100;
	const door = frontDoor({
		namespace: recordingNamespace().namespace,
		index: index.namespace,
		tokens: { playground: TOKEN },
		recipes: ["shell", "tool-table"],
		now: () => now,
	});

	for (const name of ["first", "second"]) {
		now += 10;
		const created = await door(
			api("/api/sessions", {
				method: "POST",
				token: TOKEN,
				body: { recipe: "shell", label: name },
			}),
		);
		expect(created.status).toBe(201);
	}

	const listed = await door(api("/api/sessions", { token: TOKEN }));
	expect(listed.status).toBe(200);
	const sessions = ((await listed.json()) as { sessions: { label: string; lastUsed: number }[] })
		.sessions;
	expect(sessions.map((entry) => entry.label)).toEqual(["second", "first"]);
	expect(sessions[0]?.lastUsed).toBe(120);
});

test("PGS13 a touch moves a conversation up, and names nothing that does not exist", async () => {
	const index = indexedNamespace();
	let now = 100;
	const door = frontDoor({
		namespace: recordingNamespace().namespace,
		index: index.namespace,
		tokens: { playground: TOKEN },
		recipes: ["shell", "tool-table"],
		now: () => now,
	});

	const created = await door(
		api("/api/sessions", {
			method: "POST",
			token: TOKEN,
			body: { recipe: "shell", label: "one" },
		}),
	);
	expect(created.status).toBe(201);

	now = 500;
	const touched = await door(api("/api/sessions/unique-1", { method: "PUT", token: TOKEN }));
	expect(touched.status).toBe(200);
	expect(await touched.json()).toMatchObject({ session: "unique-1", lastUsed: 500 });

	const missing = await door(api("/api/sessions/nobody", { method: "PUT", token: TOKEN }));
	expect(missing.status).toBe(404);

	const anonymous = await door(api("/api/sessions/unique-1", { method: "PUT" }));
	expect(anonymous.status).toBe(403);
});

test("PGS14 the playground's own routes are the only thing outside /v1 it answers", async () => {
	const index = indexedNamespace();
	const door = frontDoor({
		namespace: recordingNamespace().namespace,
		index: index.namespace,
		tokens: { playground: TOKEN },
		recipes: ["shell"],
		now: () => 1,
	});

	// `/api/*` is claimed by `run_worker_first`, so anything there is this function's to
	// refuse rather than the page's to answer.
	const unknown = await door(api("/api/nothing", { token: TOKEN }));
	expect(unknown.status).toBe(404);
	expect(((await unknown.json()) as { error: { code: string } }).error.code).toBe("not_found");
	expect(index.names).toEqual([]);
});

test("PGS15 the picker offers exactly the recipes the session will run", async () => {
	const index = indexedNamespace();
	const door = frontDoor({
		namespace: recordingNamespace().namespace,
		index: index.namespace,
		tokens: { playground: TOKEN },
		recipes: [...recipeCatalogue(fakeClock()).keys()],
		now: () => 1,
	});

	const response = await door(api("/api/recipes", { token: TOKEN }));
	expect(response.status).toBe(200);
	const offered = ((await response.json()) as { recipes: string[] }).recipes;
	// The same map a `start` is answered from, so the picker cannot offer a name the
	// session would refuse, and cannot hide one nobody could reach.
	expect(offered).toEqual([
		...sessionOptions({ ...env(index.namespace), MODEL_SOURCE: "placeholder" }).recipes.keys(),
	]);
	expect(offered).toContain("tool-table");

	const refused = await door(api("/api/recipes"));
	expect(refused.status).toBe(403);
});
