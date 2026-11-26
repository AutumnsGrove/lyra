/**
 * The playground's Durable Object: one session, one record (issue #60, slice 1).
 *
 * Everything that makes a session work comes from the Cloudflare adapter — the record
 * in SQLite, the alarm as the wake, the protocol over HTTP and the socket. What this
 * file adds is the host's own three answers: which recipes it runs, which model it
 * asks, and whose token opens the door.
 */

import { systemClock, systemIds } from "@autumnsgrove/lyra";
import {
	createCloudflareSession,
	type CloudflareSession,
	type CloudflareSessionOptions,
} from "@autumnsgrove/lyra/cloudflare";
import type { FetchLike } from "@autumnsgrove/lyra/openai";

import { modelFor } from "./model.js";
import { recipeCatalogue } from "./recipes/catalogue.js";

/** What the Worker's bindings give this object. A token is a secret, never a var. */
export interface Env {
	SESSION: DurableObjectNamespace;
	/** The per-tenant conversation index the sidebar reads (issue #60, slice 3). */
	INDEX: DurableObjectNamespace;
	/**
	 * Optional because a secret that was never set arrives as `undefined`, whatever the
	 * type says: the binding is created by `wrangler secret put`, and nothing makes that
	 * happen before the first request.
	 *
	 * Prefixed, because the `gw secret` vault is shared across the Grove Workers and its
	 * rule is that a name says which project it belongs to (issue #60, slice 2).
	 */
	LYRA_PLAYGROUND_TOKEN?: string | undefined;
	LYRA_PLAYGROUND_TENANT?: string | undefined;
	/** The model provider's key, also prefixed. `model.ts` maps it to the adapter's name. */
	LYRA_PLAYGROUND_OPENROUTER_API_KEY?: string | undefined;
	/** Which model slot to build: `openrouter` (the default) or `placeholder`. */
	MODEL_SOURCE?: string | undefined;
	/** A comma-separated allow-list. Unset means `DEFAULT_MODELS`. */
	PLAYGROUND_MODELS?: string | undefined;
}

/**
 * Tenant to token, exactly as the adapter's door reads it.
 *
 * A missing or empty token binds nothing rather than binding "". The door hashes
 * whatever string it is given, so an empty one would be a working credential nobody
 * chose — the door would accept `Bearer ` if the header ever arrived with its space
 * intact. Returning no tenant makes every request a `permission_denied`, which is the
 * safe direction by construction rather than by a header being trimmed (found in review).
 */
export function tokensFrom(env: Env): Readonly<Record<string, string>> {
	const tenant = env.LYRA_PLAYGROUND_TENANT;
	const token = env.LYRA_PLAYGROUND_TOKEN;
	if (typeof tenant !== "string" || tenant === "" || typeof token !== "string" || token === "") {
		return {};
	}
	return { [tenant]: token };
}

/** The host's half of the session, which is what a later slice varies by model source. */
export function sessionOptions(
	env: Env,
	deps: { fetch?: FetchLike } = {},
): CloudflareSessionOptions {
	// One clock for the loop and the model, so a deadline and a record timestamp agree.
	const clock = systemClock();
	return {
		// The same `fetch` the model uses: a test supplies one, and a deployment gets the
		// Worker's own, so a run's network is whatever the host chose and nothing else.
		recipes: recipeCatalogue(clock, deps.fetch === undefined ? {} : { fetch: deps.fetch }),
		model: modelFor(env, { clock, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) }),
		clock,
		ids: systemIds(),
		tokens: tokensFrom(env),
		host: "packages/playground",
	};
}

export class Session implements DurableObject {
	#session: CloudflareSession | undefined;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	#build(): CloudflareSession {
		this.#session ??= createCloudflareSession(this.ctx, sessionOptions(this.env));
		return this.#session;
	}

	async fetch(request: Request): Promise<Response> {
		return this.#build().fetch(request);
	}

	async alarm(): Promise<void> {
		await this.#build().alarm();
	}

	/** A socket accepted here hibernates with the object, and a frame wakes it. */
	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.#build().webSocketMessage(socket, message);
	}

	webSocketClose(socket: WebSocket, code: number, reason: string): void {
		this.#build().webSocketClose(socket, code, reason);
	}

	webSocketError(socket: WebSocket, error: unknown): void {
		void error;
		this.#build().webSocketError(socket);
	}
}
