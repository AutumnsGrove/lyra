/**
 * A session as a Durable Object, and the Worker that routes to it
 * (docs/implementation/06-protocol-http.md, slice 5; decisions 12, 45 and 47).
 *
 * One object is one session, so one record, one run and one alarm, which is what
 * the storage and waking adapters already assume. The object answers the protocol
 * through the same handler a test and `wrangler dev` use, resumes itself through
 * its alarm, and offers a second door for a trusted Grove worker: a method that
 * names the tenant, because a service binding has no bearer token and a binding's
 * caller is not reachable from the public `fetch` route at all.
 *
 * The types here are structural, like the storage and waking adapters': the core
 * builds with no platform types, and a Worker's real `DurableObjectState` and
 * namespace satisfy these shapes.
 */

import type { Clock, Ids } from "../../core/clock.js";
import type { ModelSlot } from "../../core/model.js";
import { fail, ok, type Result } from "../../core/result.js";
import { createRuntime, type RunDefinition, type Runtime } from "../../core/runtime.js";
import { loadRecord } from "../../record/load.js";
import {
	createHttpHandler,
	createTokenDoor,
	refusalResponse,
	type SessionHost,
} from "../../protocol/http.js";
import { createSession, type Session } from "../../protocol/session.js";
import type { StorageSlot } from "../../core/slots.js";
import { durableObjectStorage } from "./storage.js";
import { alarmWaking, scheduledWake, type DurableObjectAlarmStorage } from "./waking.js";

/** What this adapter needs from a Durable Object's id, and nothing else. */
export interface DurableObjectIdLike {
	toString(): string;
}

/** What it needs from a stub: a request in, a response out. */
export interface DurableObjectStubLike {
	fetch(request: Request): Promise<Response>;
}

/** What it needs from the namespace: the three ways to name an object. */
export interface DurableObjectNamespaceLike {
	idFromName(name: string): DurableObjectIdLike;
	idFromString(hex: string): DurableObjectIdLike;
	newUniqueId(): DurableObjectIdLike;
	get(id: DurableObjectIdLike): DurableObjectStubLike;
}

/** What a session object needs from its `DurableObjectState`. */
export interface DurableObjectStateLike {
	readonly id: DurableObjectIdLike;
	readonly storage: DurableObjectAlarmStorage;
}

export interface CloudflareSessionOptions {
	/** The tasks this host runs, by name. A Worker's own code is where these come from. */
	recipes: ReadonlyMap<string, RunDefinition>;
	model: ModelSlot;
	clock: Clock;
	ids: Ids;
	/** Tenant to token, from a secret binding. Never logged, never recorded. */
	tokens: Readonly<Record<string, string>>;
	host: string;
	/** How many events may queue for one watching client before it is dropped. */
	maxQueuedEvents?: number;
}

export interface CloudflareSession {
	/** The public door: the protocol over HTTP, with a bearer token. */
	fetch(request: Request): Promise<Response>;
	/** The object's alarm, which continues a run whose host died. */
	alarm(): Promise<void>;
	/**
	 * The trusted door: run one command frame for a tenant a service binding named.
	 * It answers with the response frame, exactly as the wire would, so the caller
	 * needs no second parser.
	 */
	send(request: { tenant: string; frame: string }): Promise<string>;
}

/**
 * The object id a `start` lands on: the named session, the tenant and idempotency
 * key, or a fresh one. A repeated command with the same key therefore reaches the
 * same object, which is what makes a cron retry safe (`CMD02`, `CMD03`).
 */
export function sessionIdFor(
	namespace: DurableObjectNamespaceLike,
	request: { tenant: string; session?: string; key?: string },
): Result<DurableObjectIdLike> {
	if (request.session !== undefined) {
		try {
			return ok(namespace.idFromString(request.session));
		} catch {
			return fail("not_found", "there is no such session");
		}
	}
	if (request.key !== undefined) {
		return ok(namespace.idFromName(`${request.tenant}:${request.key}`));
	}
	return ok(namespace.newUniqueId());
}

export function createCloudflareSession(
	state: DurableObjectStateLike,
	options: CloudflareSessionOptions,
): CloudflareSession {
	const id = state.id.toString();
	const storage: StorageSlot = durableObjectStorage(state.storage);
	/** Whose the session is, once it is known; the record's header is the truth after a restart. */
	let owner: string | undefined;
	let session: Session | undefined;

	/** The header's tenant, or nothing when there is no record yet. */
	const recordedTenant = async (): Promise<Result<string | undefined>> => {
		const read = await storage.read();
		if (!read.ok) {
			return read;
		}
		if (read.value.length === 0) {
			return ok(undefined);
		}
		const loaded = loadRecord(read.value);
		if (!loaded.ok) {
			return fail(
				"internal",
				`this session's record could not be read: ${loaded.error.message}`,
			);
		}
		return ok(loaded.value.header.tenant);
	};

	const build = (tenant: string): Session => {
		if (session !== undefined) {
			return session;
		}
		const runtime: Runtime = createRuntime({
			storage,
			waking: alarmWaking(state.storage),
			clock: options.clock,
			ids: options.ids,
			model: options.model,
			host: options.host,
			tenant,
		});
		session = createSession({
			id,
			storage,
			clock: options.clock,
			ids: options.ids,
			model: options.model,
			host: options.host,
			tenant,
			recipes: options.recipes,
			runtime,
		});
		return session;
	};

	/**
	 * The host seam the HTTP handler opens sessions through. There is one object per
	 * session, so opening anything but this one is `not_found`, and so is a caller of
	 * another tenant for the same reason: it must not learn the session exists.
	 */
	const host: SessionHost = {
		async open({ tenant, session: named }) {
			if (named !== undefined && named !== id) {
				return fail("not_found", `there is no session ${named}`);
			}
			const recorded = await recordedTenant();
			if (!recorded.ok) {
				return recorded;
			}
			const belongs = recorded.value ?? owner;
			if (belongs !== undefined && belongs !== tenant) {
				return fail("not_found", "there is no such session");
			}
			owner ??= tenant;
			return ok(build(tenant));
		},
	};

	const handler = createHttpHandler(host, {
		tenantFor: createTokenDoor(options.tokens),
		...(options.maxQueuedEvents === undefined
			? {}
			: { maxQueuedEvents: options.maxQueuedEvents }),
	});

	return {
		fetch: handler,

		send: async ({ tenant, frame }) => {
			const trusted = createHttpHandler(host, {
				tenantFor: async () => ok(tenant),
			});
			const response = await trusted(
				new Request("https://session.internal/v1/commands", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: frame,
				}),
			);
			return response.text();
		},

		alarm: async () => {
			try {
				const wake = await scheduledWake(state.storage);
				if (wake === undefined) {
					return;
				}
				const recorded = await recordedTenant();
				const tenant = recorded.ok ? (recorded.value ?? owner) : owner;
				if (tenant === undefined) {
					// No record, so nothing to wake and nobody to wake it for.
					return;
				}
				await build(tenant).wake(wake.runId);
			} catch {
				// An alarm is retried when its handler throws, so a domain failure is not a
				// reason to have Cloudflare deliver it forever.
			}
		},
	};
}

export interface CloudflareWorkerOptions {
	namespace: DurableObjectNamespaceLike;
	tokens: Readonly<Record<string, string>>;
	/** How many events may queue for one client; passed through to the object. */
	maxQueuedEvents?: number;
}

/**
 * The public `fetch` of a Worker whose sessions are Durable Objects: it authenticates,
 * finds which object the request is about, and hands the request over. The service
 * binding's entry point is the host's own class (a `WorkerEntrypoint` with a method
 * that calls the object's `send`), because declaring one needs the Workers runtime's
 * types, which the core's program does not have.
 */
export function createSessionWorker(
	options: CloudflareWorkerOptions,
): (request: Request) => Promise<Response> {
	const door = createTokenDoor(options.tokens);
	return async (request) => {
		const tenant = await door(request);
		if (!tenant.ok) {
			return refusalResponse(tenant.error.code, tenant.error.message);
		}
		const url = new URL(request.url);
		let target: Result<DurableObjectIdLike>;
		let forward: Request;
		if (request.method === "POST" && url.pathname === "/v1/commands") {
			const body = await request.text();
			const route = routeOf(body, tenant.value);
			if (!route.ok) {
				return refusalResponse(route.error.code, route.error.message);
			}
			target = sessionIdFor(options.namespace, route.value);
			forward = new Request(request.url, {
				method: "POST",
				// The token travels on, because the object serves the same door and must
				// know whose request this is; a caller that skipped the Worker is refused
				// by the object itself.
				headers: request.headers,
				body,
			});
		} else if (request.method === "GET") {
			const named = url.searchParams.get("session");
			if (named === null || named === "") {
				return refusalResponse("bad_request", "this route needs a session");
			}
			target = sessionIdFor(options.namespace, { tenant: tenant.value, session: named });
			forward = request;
		} else {
			// Nothing but a command or a stream names a session, so there is no object to
			// ask and the answer is the handler's own.
			return refusalResponse("not_found", `there is nothing at ${url.pathname}`);
		}
		if (!target.ok) {
			return refusalResponse(target.error.code, target.error.message);
		}
		return options.namespace.get(target.value).fetch(forward);
	};
}

/** Which session a command request names, read from the frame it carries. */
function routeOf(
	body: string,
	tenant: string,
): Result<{ tenant: string; session?: string; key?: string }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		// The object's own handler answers a body it cannot read; there is no session to
		// route to, so the refusal comes from here instead.
		return fail("bad_request", "a command request holds one frame of JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		return fail("bad_request", "a command request holds one frame of JSON");
	}
	const fields = parsed as Record<string, unknown>;
	const session = typeof fields["session"] === "string" ? fields["session"] : undefined;
	const key = typeof fields["key"] === "string" ? fields["key"] : undefined;
	if (session === undefined && key === undefined && fields["command"] !== "start") {
		return fail("bad_request", "a command over HTTP needs a session");
	}
	return ok({
		tenant,
		...(session === undefined ? {} : { session }),
		...(key === undefined ? {} : { key }),
	});
}
