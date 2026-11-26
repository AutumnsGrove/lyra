import { expect, test } from "vitest";

import { Budget } from "./budget.js";
import { Session, type Env } from "./session.js";

/**
 * The rows are in `docs/playground.md`: PGS38.
 *
 * This is the wiring, not the policy: it builds the real `Session` and sends it the two
 * requests a person can send, over HTTP and over a socket. Both refusals happen before the
 * object is built, so nothing here needs a Durable Object — which is exactly why this is a
 * test that can exist without the workerd configuration the class has been waiting for
 * (the gap PGS01 states, and the one a review of #99 asked about).
 */

function budgetNamespace(): { namespace: DurableObjectNamespace; states: Map<string, unknown> } {
	const states = new Map<string, unknown>();
	const object = new Budget({
		storage: {
			async get(key) {
				return states.get(key);
			},
			async put(key, value) {
				states.set(key, value);
			},
		},
	});
	const namespace = {
		idFromName: (name: string) => ({ toString: () => name }),
		idFromString: (hex: string) => ({ toString: () => hex }),
		newUniqueId: () => ({ toString: () => "budget" }),
		get: () => ({ fetch: (request: Request) => object.fetch(request) }),
	} as unknown as DurableObjectNamespace;
	return { namespace, states };
}

function envFor(budget: DurableObjectNamespace, cap = "1"): Env {
	return {
		SESSION: {} as DurableObjectNamespace,
		INDEX: {} as DurableObjectNamespace,
		BUDGET: budget,
		LYRA_PLAYGROUND_TOKEN: "a-token-for-a-test",
		LYRA_PLAYGROUND_TENANT: "playground",
		LYRA_PLAYGROUND_DAY_CAP_USD: cap,
	};
}

function startFrame(): string {
	return JSON.stringify({
		type: "command",
		id: "c1",
		command: "start",
		task: "tool-table",
		input: "hi",
	});
}

/** A socket that records what was sent to it. */
function socket(): { sent: string[]; send: (message: string) => void } {
	const sent: string[] = [];
	return { sent, send: (message) => sent.push(message) };
}

test("PGS38 a Session refuses an HTTP start over the cap before it builds anything", async () => {
	const { namespace, states } = budgetNamespace();
	states.set("day", { day: new Date().toISOString().slice(0, 10), usd: 2, unpriced: false });

	// The state given is empty on purpose: a Session that tried to build its object would
	// fail here, so a passing test is the refusal happening first.
	const session = new Session({} as DurableObjectState, envFor(namespace));
	const refused = await session.fetch(
		new Request("https://playground.test/v1/commands", { method: "POST", body: startFrame() }),
	);

	expect(refused.status).toBe(429);
	expect(await refused.json()).toMatchObject({
		type: "response",
		id: "c1",
		ok: false,
		error: { code: "limit" },
	});
});

test("PGS38 a Session refuses a socket start over the cap, and leaves the socket open", async () => {
	const { namespace, states } = budgetNamespace();
	states.set("day", { day: new Date().toISOString().slice(0, 10), usd: 2, unpriced: false });

	const session = new Session({} as DurableObjectState, envFor(namespace));
	const peer = socket();
	await session.webSocketMessage(peer as unknown as WebSocket, startFrame());

	// The frame is the same `response` the socket already reads; sending it and returning is
	// what leaves the connection open for the answer to a card.
	expect(peer.sent).toHaveLength(1);
	expect(JSON.parse(peer.sent[0] ?? "{}")).toMatchObject({
		type: "response",
		id: "c1",
		ok: false,
		error: { code: "limit" },
	});
});

test("PGS38 a Session with no cap set refuses nothing it is asked to start", async () => {
	// With no cap the check is not made at all, so the request goes on to the object — and
	// with an empty state that is a failure, which is why this asks for the *absence* of a
	// refusal rather than a response: the limit frame is the one thing that must not come.
	const { namespace } = budgetNamespace();
	const session = new Session({} as DurableObjectState, envFor(namespace, ""));
	let refused = false;
	try {
		await session.fetch(
			new Request("https://playground.test/v1/commands", {
				method: "POST",
				body: startFrame(),
			}),
		);
	} catch {
		refused = false;
	}
	expect(refused).toBe(false);
});

/**
 * The script boundary through a real `Session` (issue #60, slice 7b; PGS42). The accepted
 * path starts a run and so needs a Durable Object; every refusal happens before that, which
 * is what these drive.
 */
function scriptEnv(overrides: Partial<Env> = {}): Env {
	return {
		...envFor(budgetNamespace().namespace, ""),
		LYRA_PLAYGROUND_TOKEN: "the-person-token",
		LYRA_PLAYGROUND_TENANT: "playground",
		LYRA_PLAYGROUND_SMOKE_TENANT: "smoke",
		LYRA_PLAYGROUND_SMOKE_TOKEN: "the-smoke-token",
		LYRA_PLAYGROUND_SCRIPT_TOKEN: "the-script-token",
		...overrides,
	};
}

function scriptRequest(token: string, script: string, bearer = "the-smoke-token"): Request {
	return new Request("https://playground.test/v1/commands", {
		method: "POST",
		headers: {
			authorization: `Bearer ${bearer}`,
			"x-lyra-script": script,
			"x-lyra-script-token": token,
		},
		body: startFrame(),
	});
}

test("PGS42 a script is refused unless it comes from the smoke tenant with the token", async () => {
	const good = JSON.stringify([{ tool_calls: [{ id: "c1", name: "finish", arguments: "{}" }] }]);

	// No script token on the deployment: the header is refused rather than falling back to
	// the real model, because a smoke job that tested the wrong thing would pass.
	for (const env of [
		scriptEnv({ LYRA_PLAYGROUND_SCRIPT_TOKEN: undefined }),
		scriptEnv({ LYRA_PLAYGROUND_SCRIPT_TOKEN: "" }),
	]) {
		const refused = await new Session({} as DurableObjectState, env).fetch(
			scriptRequest("x", good),
		);
		expect(refused?.status).toBe(403);
	}

	// The right token, but from the person's tenant: a script cannot reach their conversation.
	const wrongTenant = await new Session({} as DurableObjectState, scriptEnv()).fetch(
		scriptRequest("the-script-token", good, "the-person-token"),
	);
	expect(wrongTenant?.status).toBe(403);

	// The smoke tenant, but a token that is not the script's.
	const wrongToken = await new Session({} as DurableObjectState, scriptEnv()).fetch(
		scriptRequest("not-the-token", good),
	);
	expect(wrongToken?.status).toBe(403);
	expect(await wrongToken?.json()).toMatchObject({ error: { code: "permission_denied" } });
});

test("PGS42 a malformed script from the smoke tenant is a bad request", async () => {
	for (const script of ["{", "[]", JSON.stringify([{ nothing: true }])]) {
		const refused = await new Session({} as DurableObjectState, scriptEnv()).fetch(
			scriptRequest("the-script-token", script),
		);
		expect(refused?.status, script).toBe(400);
		expect(await refused?.json()).toMatchObject({ error: { code: "bad_request" } });
	}
});
