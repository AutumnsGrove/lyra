/**
 * The Worker under test (docs/implementation/04-cloudflare-adapter.md, and step 6's
 * slice 5 for the session object).
 *
 * It exists so the plugin has a module to boot and Durable Object classes to
 * migrate. It is test support, so it is named `.testing.ts`: the library build, the
 * budget and the coverage floor all leave it out, and it may import the testkit
 * even though nothing in the adapter's production code may.
 *
 * `/v1/*` goes through `createSessionWorker`, which is the routing a host writes;
 * `/service` is the trusted door a service-binding entry point would call; and any
 * other path is the step-4 probe.
 */

import { createSessionWorker, sessionIdFor } from "../session.js";
import { TOKENS, TestSession } from "./session-class.testing.js";
import { FixtureSession } from "./fixture-session.testing.js";

export { FixtureSession, TestSession };

interface SessionStub extends DurableObjectStub {
	send(request: { tenant: string; frame: string }): Promise<string>;
}

export default {
	async fetch(request: Request, env: Cloudflare.Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/service") {
			// The shape a WorkerEntrypoint's method has: a named tenant and one frame.
			const body = (await request.json()) as { session: string; frame: string };
			const stub = env.SESSION.get(
				env.SESSION.idFromString(body.session),
			) as unknown as SessionStub;
			const answer = await stub.send({ tenant: "acme", frame: body.frame });
			return new Response(answer, { headers: { "content-type": "application/json" } });
		}
		if (url.pathname.startsWith("/v1/")) {
			const route = createSessionWorker({ namespace: env.SESSION, tokens: TOKENS });
			return route(request);
		}
		return new Response("lyra cloudflare fixture");
	},
};

export { sessionIdFor };
