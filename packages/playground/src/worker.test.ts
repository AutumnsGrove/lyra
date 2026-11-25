import { expect, test } from "vitest";

import type {
	DurableObjectNamespaceLike,
	DurableObjectStubLike,
} from "@autumnsgrove/lyra/cloudflare";

import { tokensFrom, type Env } from "./session.js";
import { frontDoor } from "./worker.js";

/** The rows are in `docs/implementation/C-playground.md`, Slice 1. */

const TOKEN = "a-playground-token-for-a-test";

/**
 * The bindings the deployed Worker has, so the token map is the one the Worker makes
 * rather than one the test made up: a tenant paired with the wrong token would pass a
 * test that handed the door its own map.
 */
function env(): Env {
	return {
		SESSION: {} as DurableObjectNamespace,
		PLAYGROUND_TOKEN: TOKEN,
		PLAYGROUND_TENANT: "playground",
	};
}

interface Recorded {
	namespace: DurableObjectNamespaceLike;
	forwarded: string[];
	/** Every object name the router derived, which is where the tenant shows. */
	names: string[];
	/** How many times the object was even asked for, which a refusal must not do. */
	asked: () => number;
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
	return { namespace, forwarded, names, asked: () => forwarded.length };
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

test("PGS01 the front door refuses a command without the token, and never asks the object", async () => {
	const { namespace, asked } = recordingNamespace();
	const response = await frontDoor({ namespace, tokens: tokensFrom(env()) })(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			body: startFrame(),
		}),
	);

	// 403 is what the command surface answers for an unknown or missing token (HTP02),
	// and the object must not be woken for a request the Worker already refused.
	expect(response.status).toBe(403);
	const body = (await response.json()) as { error?: { code?: string } };
	expect(body.error?.code).toBe("permission_denied");
	expect(asked()).toBe(0);
});

test("PGS01 a command with the token reaches the object for the token's tenant", async () => {
	const { namespace, forwarded, names } = recordingNamespace();
	const response = await frontDoor({ namespace, tokens: tokensFrom(env()) })(
		new Request("https://playground.test/v1/commands", {
			method: "POST",
			headers: { authorization: `Bearer ${TOKEN}` },
			body: startFrame(),
		}),
	);

	expect(response.status).toBe(200);
	expect(forwarded).toEqual(["POST /v1/commands"]);
	// The object name carries the tenant the token resolved to, so a token paired with
	// the wrong tenant would put this run in someone else's session and fail here.
	expect(names).toEqual(["playground:k1"]);
});

test("PGS01 a page request is not the Worker's business, and an unknown /v1 path is a refusal", async () => {
	const { namespace, forwarded } = recordingNamespace();
	const door = frontDoor({ namespace, tokens: tokensFrom(env()) });

	// The page is served from the Worker's assets, so this only has to not be answered
	// as a protocol route: a request that does reach the Worker is the adapter's 404.
	const page = await door(
		new Request("https://playground.test/", {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	expect(page.status).toBe(404);

	const service = await door(
		new Request("https://playground.test/v1/nothing-here", {
			headers: { authorization: `Bearer ${TOKEN}` },
		}),
	);
	expect(service.status).toBe(404);
	expect(forwarded).toEqual([]);
});
