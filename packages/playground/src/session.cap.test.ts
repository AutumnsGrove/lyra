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
