/**
 * The protocol over HTTP (docs/protocol.md, "Replay from the record", "Access"
 * and the HTTP rows; decisions 45 and 87).
 *
 * A web-standard `(Request) => Promise<Response>`, so the same handler runs in a
 * Durable Object (step 6), under `wrangler dev`, and in a test. It owns routing,
 * the version header, the status each error code maps to, and the server-sent
 * event stream; the session owns the commands and the record.
 *
 * Two things are deliberate. The body of every answer is a frame, even when the
 * HTTP status already says what went wrong, so a client reads one shape. And a
 * refusal from the host is never passed through word for word: a host's message
 * can name a session id, and a keyed session's id is derived from its tenant, so
 * another tenant's mistake must not hint at what is there (`ACC01`).
 */

import { isErrorCode, fail, ok, type ErrorCode, type Result } from "../core/result.js";
import type { JsonValue } from "../core/json.js";
import { DEFAULT_LINE_CAP_BYTES, lineReader } from "./reader.js";
import { decodeAnswer } from "./answers.js";
import { decodeCommand } from "./commands.js";
import { decodeFrame, responseFrame } from "./frames.js";
import type { Session, SessionEvent } from "./session.js";

/** The protocol version this build speaks, and what the header means when it is missing. */
export const PROTOCOL_VERSION = "1";

/**
 * Where a session comes from. The handler never creates storage or objects; a
 * Durable Object host or a test's in-memory host does, and answers `not_found`
 * for a session that belongs to another tenant or does not exist.
 */
export interface SessionHost {
	open(request: { tenant: string; session?: string; key?: string }): Promise<Result<Session>>;
}

export interface HttpOptions {
	/** The tenant a request may act as, or a refusal. A door with no token never gets here. */
	tenantFor(request: Request): Promise<Result<string>>;
	/** The most bytes one request body may carry. Defaults to the line cap. */
	maxBodyBytes?: number;
	/** How many events may queue for a client before it is dropped. */
	maxQueuedEvents?: number;
}

/** The status each stable code maps to, so a plain HTTP client behaves (decision 45). */
export function statusForCode(code: ErrorCode): number {
	switch (code) {
		case "bad_request":
			return 400;
		case "permission_denied":
			return 403;
		case "not_found":
			return 404;
		case "busy":
		case "conflict":
			return 409;
		case "unsupported":
			return 501;
		case "timeout":
			return 504;
		case "provider_error":
			return 502;
		case "internal":
			return 500;
	}
}

/** A bearer token's digest, so the comparison does not depend on where it differs. */
async function digest(token: string): Promise<Uint8Array> {
	return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
}

/** Equal only when every byte is, with no early exit (decision 87). */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
	if (left.length !== right.length) {
		return false;
	}
	let difference = 0;
	for (let index = 0; index < left.length; index += 1) {
		difference |= (left[index] as number) ^ (right[index] as number);
	}
	return difference === 0;
}

/**
 * The public door: a bearer token names its tenant, and the token is compared by
 * digest so a wrong one costs the same time whatever it is. The secrets are a
 * tenant-to-token map, as `docs/protocol.md` says; nothing here logs or records a
 * token, and a refusal never repeats one.
 */
export function createTokenDoor(
	tokens: Readonly<Record<string, string>>,
): (request: Request) => Promise<Result<string>> {
	const entries = Object.entries(tokens).map(async ([tenant, token]) => ({
		tenant,
		digest: await digest(token),
	}));
	return async (request) => {
		const header = request.headers.get("authorization");
		if (header === null || !header.startsWith("Bearer ")) {
			return fail("permission_denied", "a request needs a bearer token");
		}
		const presented = await digest(header.slice("Bearer ".length));
		for (const candidate of await Promise.all(entries)) {
			if (sameBytes(presented, candidate.digest)) {
				return ok(candidate.tenant);
			}
		}
		return fail("permission_denied", "that token is not one this host knows");
	};
}

function headers(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-lyra-version": PROTOCOL_VERSION,
	};
}

/** One answer, as a frame, with the status its code maps to. */
function answer(id: string, command: string, outcome: Result<JsonValue>): Response {
	const frame = responseFrame(id, command, outcome);
	const status = outcome.ok
		? 200
		: statusForCode(isErrorCode(outcome.error.code) ? outcome.error.code : "internal");
	return new Response(JSON.stringify(frame), { status, headers: headers() });
}

/** A refusal that has no command behind it: no token, no version, no route. */
export function refusalResponse(code: ErrorCode, message: string): Response {
	return answer("", "", fail(code, message));
}

/** The same, for the paths inside this module. */
const refusal = refusalResponse;

/** An answer's frame echoes the caller's own `id` when it gave one, and names the route. */
function answerForFrame(fields: Record<string, unknown>, outcome: Result<JsonValue>): Response {
	const id = typeof fields["id"] === "string" ? fields["id"] : "";
	return answer(id, "ui_response", outcome);
}

/** The body, in bytes, refusing to read past the cap rather than reading and then complaining. */
async function readBody(request: Request, cap: number): Promise<Result<string>> {
	const body = request.body;
	if (body === null) {
		return ok("");
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let read = 0;
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		const value = chunk.value;
		if (value === undefined) {
			continue;
		}
		read += value.byteLength;
		if (read > cap) {
			await reader.cancel();
			return fail("bad_request", `the body is over the ${cap} bytes one request may carry`);
		}
		text += decoder.decode(value, { stream: true });
	}
	return ok(text + decoder.decode());
}

/** The one line a command body must hold, or why it is not one. */
function lineOf(body: string, cap: number): Result<string> {
	const reader = lineReader({ maxLineBytes: cap });
	const lines = [...reader.push(new TextEncoder().encode(body)).lines, ...reader.end().lines];
	if (lines.length === 0) {
		return fail("bad_request", "a command request needs one frame");
	}
	if (lines.length > 1) {
		// One command per request: two frames would make the answer ambiguous.
		return fail("bad_request", "a command request holds one frame, not several");
	}
	return ok(lines[0] as string);
}

/** The id and command name a frame claims, for an answer to a frame that was refused. */
function claimedBy(line: string): { id: string; command: string } {
	try {
		const parsed: unknown = JSON.parse(line);
		if (typeof parsed !== "object" || parsed === null) {
			return { id: "", command: "" };
		}
		const fields = parsed as Record<string, unknown>;
		return {
			id: typeof fields["id"] === "string" ? fields["id"] : "",
			command: typeof fields["command"] === "string" ? fields["command"] : "",
		};
	} catch {
		return { id: "", command: "" };
	}
}

/** One event as one server-sent-event message; `id` is the entry, when there is one. */
function eventFrame(event: SessionEvent): string {
	const id = "seq" in event ? `id: ${event.seq}\n` : "";
	return `${id}data: ${JSON.stringify(event)}\n\n`;
}

/**
 * The stream a watching client reads. A client that stops reading is dropped once
 * more than the cap is queued for it (decision 86): everything it missed is in the
 * record, so it comes back with `Last-Event-ID` instead of being buffered forever.
 */
function eventStream(
	session: Session,
	after: number,
	maxQueued: number,
): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe: (() => void) | undefined;
	return new ReadableStream<Uint8Array>({
		start(controller) {
			const send = (event: SessionEvent): void => {
				if (closed) {
					return;
				}
				try {
					controller.enqueue(encoder.encode(eventFrame(event)));
				} catch {
					closed = true;
					unsubscribe?.();
					return;
				}
				const room = controller.desiredSize;
				if (room !== null && room < -maxQueued) {
					closed = true;
					try {
						controller.close();
					} catch {
						// The stream is gone already, which is the same outcome.
					}
					unsubscribe?.();
				}
			};
			void session.follow(after, send).then((followed) => {
				if (!followed.ok) {
					closed = true;
					try {
						controller.error(followed.error.message);
					} catch {
						// Nobody is reading, so there is nobody to tell.
					}
					return;
				}
				if (closed) {
					followed.value();
					return;
				}
				unsubscribe = followed.value;
			});
		},
		cancel() {
			closed = true;
			unsubscribe?.();
		},
	});
}

export function createHttpHandler(
	host: SessionHost,
	options: HttpOptions,
): (request: Request) => Promise<Response> {
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_LINE_CAP_BYTES;
	const maxQueued = options.maxQueuedEvents ?? 1024;

	/** A session the caller asked for, or the refusal that hides whose it is. */
	const openFor = async (
		tenant: string,
		session: string | undefined,
		key?: string,
	): Promise<Result<Session>> => {
		const opened = await host.open({
			tenant,
			...(session === undefined ? {} : { session }),
			...(key === undefined ? {} : { key }),
		});
		if (opened.ok) {
			return opened;
		}
		return opened.error.code === "not_found"
			? fail("not_found", "there is no such session")
			: opened;
	};

	const commands = async (request: Request, tenant: string): Promise<Response> => {
		const body = await readBody(request, maxBodyBytes);
		if (!body.ok) {
			return refusal(body.error.code as ErrorCode, body.error.message);
		}
		const line = lineOf(body.value, maxBodyBytes);
		if (!line.ok) {
			return refusal(line.error.code as ErrorCode, line.error.message);
		}
		const claimed = claimedBy(line.value);
		const decoded = decodeFrame(line.value);
		if (!decoded.ok) {
			return answer(
				claimed.id,
				claimed.command,
				fail(decoded.error.code, decoded.error.message),
			);
		}
		const command = decodeCommand(decoded.value);
		if (!command.ok) {
			return answer(
				claimed.id,
				claimed.command,
				fail(command.error.code, command.error.message),
			);
		}
		if (command.value.command !== "start" && command.value.session === undefined) {
			// Over HTTP there is no connection to say which session a command is about;
			// a WebSocket names it once, at hello (step 8).
			return answer(
				command.value.id,
				command.value.command,
				fail("bad_request", `a ${command.value.command} over HTTP needs a session`),
			);
		}
		const opened = await openFor(
			tenant,
			"session" in command.value ? command.value.session : undefined,
			command.value.command === "start" ? command.value.key : undefined,
		);
		if (!opened.ok) {
			return answer(command.value.id, command.value.command, opened);
		}
		const done = await opened.value.command(command.value);
		return answer(command.value.id, command.value.command, done);
	};

	/**
	 * A person's answer (REQ03, REQ04). It is not a command, so it has its own
	 * decoder and names the request with `request`: every frame already has an `id`.
	 */
	const uiResponse = async (request: Request, tenant: string): Promise<Response> => {
		const body = await readBody(request, maxBodyBytes);
		if (!body.ok) {
			return refusal(body.error.code as ErrorCode, body.error.message);
		}
		const line = lineOf(body.value, maxBodyBytes);
		if (!line.ok) {
			return refusal(line.error.code as ErrorCode, line.error.message);
		}
		const decoded = decodeFrame(line.value);
		if (!decoded.ok) {
			return refusal(decoded.error.code, decoded.error.message);
		}
		const answer = decodeAnswer(decoded.value);
		if (!answer.ok) {
			return refusal(answer.error.code, answer.error.message);
		}
		const opened = await openFor(tenant, answer.value.session);
		if (!opened.ok) {
			return refusal(opened.error.code, opened.error.message);
		}
		const done = await opened.value.respond(answer.value);
		return answerForFrame(decoded.value.fields, done);
	};

	const events = async (url: URL, request: Request, tenant: string): Promise<Response> => {
		const named = url.searchParams.get("session");
		if (named === null || named === "") {
			return refusal("bad_request", "an event stream needs a session");
		}
		const opened = await openFor(tenant, named);
		if (!opened.ok) {
			return refusal(
				opened.error.code === "not_found" ? "not_found" : "internal",
				opened.error.message,
			);
		}
		const header = request.headers.get("last-event-id");
		let after = 0;
		if (header !== null) {
			const parsed = Number(header);
			if (!Number.isSafeInteger(parsed) || parsed < 0) {
				return refusal("bad_request", "last-event-id is an entry position, from zero");
			}
			after = parsed;
		}
		return new Response(eventStream(opened.value, after, maxQueued), {
			headers: {
				"content-type": "text/event-stream",
				"cache-control": "no-cache",
				"x-lyra-version": PROTOCOL_VERSION,
			},
		});
	};

	const state = async (url: URL, tenant: string): Promise<Response> => {
		const named = url.searchParams.get("session");
		if (named === null || named === "") {
			return refusal("bad_request", "the state route needs a session");
		}
		const opened = await openFor(tenant, named);
		if (!opened.ok) {
			return answer("state", "get_state", opened);
		}
		const done = await opened.value.command({
			command: "get_state",
			id: "state",
			session: named,
		});
		return answer("state", "get_state", done);
	};

	return async (request) => {
		const tenant = await options.tenantFor(request);
		if (!tenant.ok) {
			return refusal(tenant.error.code, tenant.error.message);
		}
		const version = request.headers.get("x-lyra-version");
		if (version !== null && version !== PROTOCOL_VERSION) {
			return refusal(
				"unsupported",
				`this host speaks protocol version ${PROTOCOL_VERSION}, not ${version}`,
			);
		}
		const url = new URL(request.url);
		if (request.method === "POST" && url.pathname === "/v1/commands") {
			return commands(request, tenant.value);
		}
		if (request.method === "GET" && url.pathname === "/v1/events") {
			return events(url, request, tenant.value);
		}
		if (request.method === "GET" && url.pathname === "/v1/state") {
			return state(url, tenant.value);
		}
		if (request.method === "POST" && url.pathname === "/v1/ui_response") {
			return uiResponse(request, tenant.value);
		}
		return refusal("not_found", `there is nothing at ${url.pathname}`);
	};
}
