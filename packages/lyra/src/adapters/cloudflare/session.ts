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
import { decodeCommand } from "../../protocol/commands.js";
import { DEFAULT_LINE_CAP_BYTES } from "../../protocol/reader.js";
import { decodeAnswer } from "../../protocol/answers.js";
import { CAPABILITIES, claimedBy, decodeFrame, responseFrame } from "../../protocol/frames.js";
import {
	createHttpHandler,
	createTokenDoor,
	refusalResponse,
	PROTOCOL_VERSION,
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
	/** Hibernating sockets: the platform keeps them and wakes the object for a frame. */
	acceptWebSocket(socket: WebSocket): void;
	getWebSockets(): WebSocket[];
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
	/** Hibernating sockets: the platform wakes the object for a frame or a close. */
	webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void>;
	webSocketClose(socket: WebSocket, code: number, reason: string): void;
	webSocketError(socket: WebSocket): void;
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
			// A session is where a person is reachable, so its runs may ask (decision 35).
			canAsk: true,
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

	/**
	 * The socket's own state, in the attachment: which session, whose it is, whether
	 * the hello exchange has happened, and the last `seq` sent. It is the only state
	 * a hibernated object gets back (step 8, WSK14).
	 */
	interface Attachment {
		session: string;
		tenant: string;
		greeted: boolean;
		seq: number;
	}

	const attachmentOf = (socket: WebSocket): Attachment | undefined => {
		const stored = socket.deserializeAttachment();
		if (typeof stored !== "object" || stored === null) {
			return undefined;
		}
		const fields = stored as Record<string, unknown>;
		const session = fields["session"];
		const tenant = fields["tenant"];
		const greeted = fields["greeted"];
		const seq = fields["seq"];
		if (
			typeof session !== "string" ||
			typeof tenant !== "string" ||
			typeof greeted !== "boolean" ||
			typeof seq !== "number"
		) {
			return undefined;
		}
		return { session, tenant, greeted, seq };
	};

	/**
	 * The sockets this object is following, by socket. It is memory, so a hibernated
	 * object rebuilds it from `getWebSockets()` and each socket's attachment instead
	 * of trusting it: that is the one thing a hibernating object cannot keep.
	 */
	const watching = new Map<WebSocket, () => void>();

	/** One frame out, and the attachment's `seq` moves only when an event carried one. */
	const send = (socket: WebSocket, frame: string, seq?: number): void => {
		socket.send(frame);
		if (seq === undefined) {
			return;
		}
		const attachment = attachmentOf(socket);
		if (attachment !== undefined) {
			socket.serializeAttachment({ ...attachment, seq });
		}
	};

	/**
	 * Follow this session from the socket's last `seq`, which is the same `follow` the
	 * HTTP stream uses: replay from the record, then live, with no gap and no
	 * duplicate. Idempotent, because a hibernated object calls it again for every
	 * socket it finds in `getWebSockets`.
	 */
	const watch = async (socket: WebSocket): Promise<void> => {
		if (watching.has(socket)) {
			return;
		}
		const attachment = attachmentOf(socket);
		if (attachment === undefined) {
			return;
		}
		const session = await build(attachment.tenant);
		const followed = await session.follow(attachment.seq, (event) => {
			// One frame per event, nested so the event's own `type` is not the frame's.
			send(
				socket,
				JSON.stringify({ type: "event", event }),
				"seq" in event ? event.seq : undefined,
			);
		});
		if (!followed.ok) {
			socket.close(1011, "this session cannot be followed");
			return;
		}
		watching.set(socket, followed.value);
	};

	/**
	 * Rebuild what hibernation took: the object's memory is gone, so every socket the
	 * platform still holds is followed again from its attachment's `seq`. Called
	 * before a frame is handled, which is the first moment the object runs after a
	 * wake.
	 */
	const resumeWatching = async (): Promise<void> => {
		for (const socket of state.getWebSockets()) {
			const attachment = attachmentOf(socket);
			if (attachment?.greeted === true) {
				await watch(socket);
			}
		}
	};

	const upgrade = async (request: Request, url: URL): Promise<Response> => {
		// workerd refuses a 101 to a request that did not ask to upgrade, so a plain
		// GET on the socket route is a refusal here rather than an exception there
		// (found in review).
		const asked = request.headers.get("upgrade");
		if (asked === null || asked.toLowerCase() !== "websocket") {
			return refusalResponse("bad_request", "this route is for a WebSocket upgrade");
		}
		const tenant = await createTokenDoor(options.tokens)(request);
		if (!tenant.ok) {
			// Refused before the upgrade, so no socket ever exists for a caller with no
			// token (WSK04). An upgrade answers 401 where an ordinary request answers
			// 403, which is step 8's settled choice: the handshake has not happened, so
			// there is no frame exchange to put the refusal in.
			return new Response(
				JSON.stringify({
					type: "response",
					id: "",
					command: "",
					ok: false,
					error: tenant.error,
				}),
				{ status: 401, headers: { "content-type": "application/json" } },
			);
		}
		const named = url.searchParams.get("session");
		if (named === null || named === "") {
			return refusalResponse("bad_request", "a socket needs a session");
		}
		const opened = await host.open({ tenant: tenant.value, session: named });
		if (!opened.ok) {
			return refusalResponse(opened.error.code, opened.error.message);
		}
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const since = url.searchParams.get("since");
		const seq = since === null ? 0 : Number(since);
		server.serializeAttachment({
			session: named,
			tenant: tenant.value,
			greeted: false,
			seq: Number.isSafeInteger(seq) && seq >= 0 ? seq : 0,
		} satisfies Attachment);
		state.acceptWebSocket(server);
		// The server speaks first, so a client knows the version before it sends
		// anything (step 8's settled hello).
		server.send(
			JSON.stringify({
				type: "hello",
				version: PROTOCOL_VERSION,
				server: options.host,
				capabilities: CAPABILITIES,
			}),
		);
		return new Response(null, { status: 101, webSocket: client });
	};

	const handler = createHttpHandler(host, {
		tenantFor: createTokenDoor(options.tokens),
		...(options.maxQueuedEvents === undefined
			? {}
			: { maxQueuedEvents: options.maxQueuedEvents }),
	});

	return {
		/**
		 * The upgrade, then one frame at a time (step 8, WSK01 to WSK06). The socket is
		 * accepted through the object's own `acceptWebSocket`, so it hibernates with the
		 * object and a frame wakes it; what the object keeps between frames is the
		 * attachment, never a set in memory.
		 */
		fetch: async (request) => {
			const url = new URL(request.url);
			if (request.method === "GET" && url.pathname === "/v1/ws") {
				return upgrade(request, url);
			}
			return handler(request);
		},

		/**
		 * One frame from a client (step 8, WSK01 to WSK06, and the answer path since
		 * the approvals slice). Nothing a socket sends is trusted: it is decoded by the
		 * same frame reader and the same command validator HTTP uses, and a refusal is
		 * a response frame the socket stays open for.
		 */
		webSocketMessage: async (socket: WebSocket, message: string | ArrayBuffer) => {
			const attachment = attachmentOf(socket);
			if (attachment === undefined) {
				// A socket this object cannot place is closed rather than guessed at.
				socket.close(1011, "this socket has no session");
				return;
			}
			await resumeWatching();
			const text = typeof message === "string" ? message : new TextDecoder().decode(message);
			// A frame over the line cap closes the socket rather than being read, which is
			// FRM01's rule and step 8's close code 1002. Messages are already delimited,
			// so this is the one size check the socket needs.
			const bytes =
				typeof message === "string"
					? new TextEncoder().encode(message).byteLength
					: message.byteLength;
			if (bytes > DEFAULT_LINE_CAP_BYTES) {
				socket.close(1002, "a frame is over the line cap");
				return;
			}
			const decoded = decodeFrame(text);
			if (!decoded.ok) {
				// A frame that is not one still names what it claimed, so a client on a
				// multiplexed socket can pair the refusal with the request it sent.
				const claimed = claimedBy(text);
				socket.send(
					JSON.stringify(
						responseFrame(claimed.id, claimed.command, {
							ok: false,
							error: decoded.error,
						}),
					),
				);
				return;
			}
			const frame = decoded.value;
			if (frame.type === "hello") {
				const version = frame.fields["version"];
				if (version !== undefined && String(version) !== PROTOCOL_VERSION) {
					socket.send(
						JSON.stringify(
							responseFrame("", "", {
								ok: false,
								error: {
									code: "unsupported",
									message: `this host speaks protocol version ${PROTOCOL_VERSION}`,
								},
							}),
						),
					);
					return;
				}
				socket.serializeAttachment({ ...attachment, greeted: true });
				// The exchange is done, so the events start: replay from the attachment's
				// `seq`, then live (WSK07, WSK08).
				await watch(socket);
				return;
			}
			if (!attachment.greeted) {
				// No command before the exchange, and the socket stays open (WSK02).
				socket.send(
					JSON.stringify(
						responseFrame("", "", {
							ok: false,
							error: {
								code: "bad_request",
								message: "a command needs the hello exchange first",
							},
						}),
					),
				);
				return;
			}
			if (frame.type === "command") {
				const command = decodeCommand(frame);
				if (!command.ok) {
					const claimed = frame.fields;
					socket.send(
						JSON.stringify(
							responseFrame(
								typeof claimed["id"] === "string" ? claimed["id"] : "",
								typeof claimed["command"] === "string" ? claimed["command"] : "",
								{ ok: false, error: command.error },
							),
						),
					);
					return;
				}
				const session = await build(attachment.tenant);
				const answer = await session.command(command.value);
				socket.send(
					JSON.stringify(responseFrame(command.value.id, command.value.command, answer)),
				);
				return;
			}
			if (frame.type === "ui_response") {
				const answer = decodeAnswer(frame);
				if (!answer.ok) {
					socket.send(JSON.stringify(responseFrame("", "ui_response", answer)));
					return;
				}
				const session = await build(attachment.tenant);
				const done = await session.respond({
					...answer.value,
					session: attachment.session,
				});
				socket.send(JSON.stringify(responseFrame("", "ui_response", done)));
				return;
			}
			socket.send(
				JSON.stringify(
					responseFrame("", "", {
						ok: false,
						error: {
							code: "unsupported",
							message: `a ${frame.type} frame is not one a client sends`,
						},
					}),
				),
			);
		},

		/** A socket that goes away stops being watched; the run does not notice. */
		webSocketClose: (socket: WebSocket, code: number, reason: string) => {
			void code;
			void reason;
			watching.get(socket)?.();
			watching.delete(socket);
		},

		webSocketError: (socket: WebSocket) => {
			watching.get(socket)?.();
			watching.delete(socket);
		},

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
		const early = new URL(request.url);
		if (request.method === "GET" && early.pathname === "/v1/ws") {
			// Routed before this Worker's door: an upgrade is answered by the object,
			// which owns the 101 and its own token check, so a missing token is the
			// object's 401 rather than this router's 403 (WSK04).
			const named = early.searchParams.get("session");
			if (named === null || named === "") {
				return refusalResponse("bad_request", "a socket needs a session");
			}
			const id = sessionIdFor(options.namespace, { tenant: "upgrade", session: named });
			if (!id.ok) {
				return refusalResponse(id.error.code, id.error.message);
			}
			return options.namespace.get(id.value).fetch(request);
		}
		const tenant = await door(request);
		if (!tenant.ok) {
			return refusalResponse(tenant.error.code, tenant.error.message);
		}
		const version = request.headers.get("x-lyra-version");
		if (version !== null && version !== PROTOCOL_VERSION) {
			return refusalResponse(
				"unsupported",
				`this host speaks protocol version ${PROTOCOL_VERSION}, not ${version}`,
			);
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
		} else if (
			request.method === "GET" &&
			(url.pathname === "/v1/events" || url.pathname === "/v1/state")
		) {
			const named = url.searchParams.get("session");
			if (named === null || named === "") {
				// The handler's own answer for a route without its session, so a client
				// cannot tell which of the two doors refused it.
				return refusalResponse("bad_request", "this route needs a session");
			}
			target = sessionIdFor(options.namespace, { tenant: tenant.value, session: named });
			forward = request;
		} else if (request.method === "POST" && url.pathname === "/v1/ui_response") {
			// An answer names its session in the frame, the way a command does, and the
			// object serves the route itself with its own token door (REQ02).
			const body = await request.text();
			const route = answerRouteOf(body, tenant.value);
			if (!route.ok) {
				return refusalResponse(route.error.code, route.error.message);
			}
			target = sessionIdFor(options.namespace, route.value);
			forward = new Request(request.url, {
				method: "POST",
				headers: request.headers,
				body,
			});
		} else {
			return refusalResponse("not_found", `there is nothing at ${url.pathname}`);
		}
		if (!target.ok) {
			return refusalResponse(target.error.code, target.error.message);
		}
		return options.namespace.get(target.value).fetch(forward);
	};
}

/** Which session a command request names, read from the frame it carries. */
/**
 * Which session an answer is for, read off the frame the way a command's is. The
 * object still checks the token and the tenant; this only chooses the door (REQ02).
 */
function answerRouteOf(body: string, tenant: string): Result<{ tenant: string; session: string }> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(body);
	} catch {
		return fail("bad_request", "an answer holds one frame of JSON");
	}
	if (typeof parsed !== "object" || parsed === null) {
		return fail("bad_request", "an answer holds one frame of JSON");
	}
	const fields = parsed as Record<string, unknown>;
	const session = fields["session"];
	if (typeof session !== "string" || session === "") {
		return fail("bad_request", "an answer over HTTP needs a session");
	}
	return ok({ tenant, session });
}

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
