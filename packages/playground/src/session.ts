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

import { refusalResponse } from "@autumnsgrove/lyra";
import { capFrom, refusalFor, socketRefusal, utcDay } from "./cap.js";
import { modelFor } from "./model.js";
import { decodeScript, tokenMatches, type ScriptTurn } from "./script.js";
import { recipeCatalogue } from "./recipes/catalogue.js";

/** What the Worker's bindings give this object. A token is a secret, never a var. */
export interface Env {
	SESSION: DurableObjectNamespace;
	/** The per-tenant conversation index the sidebar reads (issue #60, slice 3). */
	INDEX: DurableObjectNamespace;
	/** The per-tenant day's spend (issue #60, slice 7; decision 161). */
	BUDGET: DurableObjectNamespace;
	/** The day's cap in dollars. Unset means no cap. */
	LYRA_PLAYGROUND_DAY_CAP_USD?: string | undefined;
	/** The tenant a scripted smoke run may use, named so it cannot be a person's. */
	LYRA_PLAYGROUND_SMOKE_TENANT?: string | undefined;
	/** That tenant's bearer token, a second credential that can only run scripts. */
	LYRA_PLAYGROUND_SMOKE_TOKEN?: string | undefined;
	/** The token a smoke request's `x-lyra-script` header must carry. Unset refuses it. */
	LYRA_PLAYGROUND_SCRIPT_TOKEN?: string | undefined;
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
	const tokens: Record<string, string> = { [tenant]: token };

	// A smoke run gets its own tenant and its own token, so a script cannot reach a person's
	// conversation: the tenant is never taken from the header, and this is the only tenant
	// scripts are allowed for (PGS42). A smoke tenant that is the person's tenant, or a pair
	// with one half missing, binds nothing extra rather than widening the door.
	const smokeTenant = env.LYRA_PLAYGROUND_SMOKE_TENANT;
	const smokeToken = env.LYRA_PLAYGROUND_SMOKE_TOKEN;
	if (
		typeof smokeTenant === "string" &&
		smokeTenant !== "" &&
		smokeTenant !== tenant &&
		typeof smokeToken === "string" &&
		smokeToken !== ""
	) {
		tokens[smokeTenant] = smokeToken;
	}
	return tokens;
}

/**
 * The tenant this request may run a script as, or nothing.
 *
 * A script is only ever for the smoke tenant, and only when the header carries the script
 * token exactly. The tenant is the one the bearer token resolved to, never a header.
 */
export function smokeTenantOf(env: Env, tenant: string): string | undefined {
	const smokeTenant = env.LYRA_PLAYGROUND_SMOKE_TENANT;
	if (typeof smokeTenant !== "string" || smokeTenant === "") {
		return undefined;
	}
	return tenant === smokeTenant ? tenant : undefined;
}

/** The host's half of the session, which is what a later slice varies by model source. */
export function sessionOptions(
	env: Env,
	deps: { fetch?: FetchLike; script?: () => readonly ScriptTurn[] | undefined } = {},
): CloudflareSessionOptions {
	// One clock for the loop and the model, so a deadline and a record timestamp agree.
	const clock = systemClock();
	return {
		// The same `fetch` the model uses: a test supplies one, and a deployment gets the
		// Worker's own, so a run's network is whatever the host chose and nothing else.
		recipes: recipeCatalogue(clock, deps.fetch === undefined ? {} : { fetch: deps.fetch }),
		model: modelFor(env, {
			clock,
			...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
			...(deps.script === undefined ? {} : { script: deps.script }),
		}),
		clock,
		ids: systemIds(),
		tokens: tokensFrom(env),
		host: "packages/playground",
	};
}

export class Session implements DurableObject {
	#session: CloudflareSession | undefined;
	/** The tenant this object first served, learned from the request's bearer. */
	#tenantName: string | undefined;
	/** The turns a scripted smoke run asks in place of a model, held for the run it started. */
	#script: ScriptTurn[] | undefined;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	#build(): CloudflareSession {
		this.#session ??= createCloudflareSession(
			this.ctx,
			sessionOptions(this.env, {
				script: () => this.#script,
				...(this.#tenantName === undefined ? {} : { tenant: this.#tenantName }),
			}),
		);
		return this.#session;
	}

	async fetch(request: Request): Promise<Response> {
		// Whose session this is, learned before anything else looks at a tenant: the budget
		// and the model both need the tenant the bearer resolved to, not the first in a map.
		this.#tenantName ??= await this.#tenantFor(request).catch(() => undefined);
		// The script boundary first: a request carrying the header is either a smoke run
		// from the smoke tenant or a refusal, and a deployment with no token refuses it
		// rather than quietly falling back to the real model (PGS42).
		const scripted = await this.#scriptRefusal(request);
		if (scripted !== undefined) {
			return scripted;
		}
		// The cap is checked before the command reaches the session: nothing starts, no
		// record is written and no model is asked when the day is over (decision 161).
		const refused = await this.#capRefusal(request);
		if (refused !== undefined) {
			return refused;
		}
		return this.#build().fetch(request);
	}

	/**
	 * The script boundary, or nothing when the request carries no header.
	 *
	 * A matching token from the smoke tenant replaces the model with the header's turns; any
	 * other request carrying the header is `permission_denied` (403, the command surface's
	 * refusal) and malformed turns are `bad_request`, both before anything runs.
	 */
	async #scriptRefusal(request: Request): Promise<Response | undefined> {
		const header = request.headers.get("x-lyra-script");
		if (header === null) {
			// A smoke tenant has no other way to run: its token exists to answer a script, and
			// a headerless `start` from it would spend the person's provider key (review on
			// #101). Its other commands — state, record, answers — are still served.
			const start = await this.#startsHere(request);
			if (start) {
				return refusalResponse(
					"permission_denied",
					"a start from the smoke tenant needs x-lyra-script and x-lyra-script-token",
				);
			}
			return undefined;
		}
		// The script travels in `x-lyra-script` and the token in `x-lyra-script-token`: one
		// header cannot be both the turns and the secret that opens the door, and the plan's
		// two rules — the token compared exactly, a script that is not JSON refused — both
		// have to hold.
		const presented = request.headers.get("x-lyra-script-token") ?? "";
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/commands") {
			return undefined;
		}

		let tenant: string | undefined;
		try {
			tenant = await this.#tenantFor(request);
		} catch {
			tenant = undefined;
		}
		const expected = this.env.LYRA_PLAYGROUND_SCRIPT_TOKEN;
		const allowed =
			typeof expected === "string" &&
			expected !== "" &&
			tenant !== undefined &&
			smokeTenantOf(this.env, tenant) !== undefined &&
			tokenMatches(expected, presented);
		if (!allowed) {
			return refusalResponse(
				"permission_denied",
				"a scripted run needs the smoke tenant and the script token",
			);
		}

		const script = decodeScript(header);
		if (!script.ok) {
			return refusalResponse("bad_request", script.error.message);
		}
		// A fresh session, so the model this request runs is the script rather than one the
		// object already built for a real run.
		this.#script = script.value;
		this.#session = undefined;
		return undefined;
	}

	/** Whether this request is a `start` from the smoke tenant, which needs a script. */
	async #startsHere(request: Request): Promise<boolean> {
		if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/commands") {
			return false;
		}
		const tenant = await this.#tenantFor(request);
		if (tenant === undefined || smokeTenantOf(this.env, tenant) === undefined) {
			return false;
		}
		try {
			const body: unknown = await request.clone().json();
			return (
				typeof body === "object" &&
				body !== null &&
				(body as { command?: unknown }).command === "start"
			);
		} catch {
			return false;
		}
	}

	/** Which tenant the request's bearer belongs to, through the same map the door uses. */
	async #tenantFor(request: Request): Promise<string | undefined> {
		const header = request.headers.get("authorization");
		if (header === null || !header.startsWith("Bearer ")) {
			return undefined;
		}
		const presented = header.slice("Bearer ".length);
		for (const [tenant, token] of Object.entries(tokensFrom(this.env))) {
			if (tokenMatches(token, presented)) {
				return tenant;
			}
		}
		return undefined;
	}

	/**
	 * The tenant this deployment serves, for the budget's object name.
	 *
	 * The tenant the first request's bearer resolved to, which is the session's own; the
	 * first key of the map is only a fallback for a socket that arrives before any HTTP
	 * request has named the tenant. Since the smoke tenant joined the map (slice 7b-i) the
	 * two can differ, and the budget must be filed under the session's tenant rather than
	 * the person's (review on #101).
	 */
	#tenant(): string {
		return this.#tenantName ?? Object.keys(tokensFrom(this.env))[0] ?? "";
	}

	/** The cap refusal for a socket frame, as the frame to send, or nothing. */
	async #socketCapRefusal(message: string | ArrayBuffer): Promise<string | undefined> {
		const cap = capFrom(this.env);
		if (cap === null) {
			return undefined;
		}
		const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName(this.#tenant()));
		return socketRefusal({
			message,
			budget: { fetch: (budgetRequest) => budget.fetch(budgetRequest) },
			cap,
			day: utcDay(systemClock().now()),
		});
	}

	/** The host's `limit` refusal for a start, or nothing to send it on. */
	async #capRefusal(request: Request): Promise<Response | undefined> {
		const cap = capFrom(this.env);
		if (cap === null || request.method !== "POST") {
			return undefined;
		}
		if (new URL(request.url).pathname !== "/v1/commands") {
			return undefined;
		}
		let body: unknown;
		try {
			// A clone, so the request the session sees is the one the client sent; a body
			// that will not parse here is left for the session to refuse in its own words.
			body = await request.clone().json();
		} catch {
			return undefined;
		}
		const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName(this.#tenant()));
		const refusal = await refusalFor({
			body,
			budget: { fetch: (budgetRequest) => budget.fetch(budgetRequest) },
			cap,
			day: utcDay(systemClock().now()),
		});
		if (refusal === undefined) {
			return undefined;
		}
		return new Response(JSON.stringify(refusal.frame), {
			status: refusal.status,
			headers: { "content-type": "application/json" },
		});
	}

	async alarm(): Promise<void> {
		await this.#build().alarm();
	}

	/** A socket accepted here hibernates with the object, and a frame wakes it. */
	async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
		// A socket command never passes through `fetch`, so the cap is checked here too;
		// the refusal is the same response frame the socket already reads, and the socket
		// stays open (found in review on #99).
		const refused = await this.#socketCapRefusal(message);
		if (refused !== undefined) {
			socket.send(refused);
			return;
		}
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
