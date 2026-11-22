import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import type { Recipe } from "../core/define-recipe.js";
import { isPlainObject, type JsonValue } from "../core/json.js";
import { fail, ok, type Result } from "../core/result.js";
import type { RunDefinition } from "../core/runtime.js";
import type { Tool } from "../core/tool.js";
import { until } from "../core/run-harness.testing.js";
import {
	createFinishTool,
	fakeClock,
	scriptedModel,
	toolReturning,
	toolTakingTime,
	type FakeClock,
	type ScriptedTurn,
} from "../testkit/index.js";
import { createHttpHandler, createTokenDoor, statusForCode, type SessionHost } from "./http.js";
import { createSession, type Session, type SessionEvent } from "./session.js";

/**
 * The HTTP surface (docs/protocol.md, "Replay from the record", "Access", and the
 * HTP rows). Requests go in as a web `Request` and come out as a web `Response`,
 * so these are the bytes a client on the wire would see.
 */

const TOKENS = { acme: "tok-acme", other: "tok-other" };

interface Host {
	clock: FakeClock;
	model: ReturnType<typeof scriptedModel>;
	sessions: Map<string, { tenant: string; session: Session }>;
	host: SessionHost;
}

function createHost(
	turns: readonly ScriptedTurn[],
	makeTools: (clock: FakeClock) => Tool[] = () => [createFinishTool()],
): Host {
	const clock = fakeClock();
	const model = scriptedModel(turns, { clock });
	const recipes = new Map<string, RunDefinition>([
		[
			"test-task",
			{
				name: "test-task",
				version: 1,
				instructions: "you are a test",
				tools: makeTools(clock),
			} satisfies Recipe,
		],
	]);
	const sessions = new Map<string, { tenant: string; session: Session }>();
	let fresh = 0;
	return {
		clock,
		model,
		sessions,
		host: {
			async open({ tenant, session, key }) {
				const id =
					session ?? (key === undefined ? `s${(fresh += 1)}` : `k:${tenant}:${key}`);
				const existing = sessions.get(id);
				if (existing !== undefined) {
					// A session of another tenant is not there, as far as this caller knows.
					return existing.tenant === tenant
						? ok(existing.session)
						: fail("not_found", `there is no session ${id}`);
				}
				const created = createSession({
					id,
					storage: memoryStorage(),
					clock,
					ids: counterIds(),
					model,
					host: "test-host",
					recipes,
				});
				sessions.set(id, { tenant, session: created });
				return ok(created);
			},
		},
	};
}

function handlerFor(host: Host, options: { maxQueuedEvents?: number; maxBodyBytes?: number } = {}) {
	return createHttpHandler(host.host, {
		tenantFor: createTokenDoor(TOKENS),
		...(options.maxQueuedEvents === undefined
			? {}
			: { maxQueuedEvents: options.maxQueuedEvents }),
		...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
	});
}

const BASE = "https://lyra.test";

function post(
	handler: (request: Request) => Promise<Response>,
	path: string,
	body: unknown,
	init: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"content-type": "application/json",
		authorization: `Bearer ${init.token ?? TOKENS.acme}`,
		...init.headers,
	};
	return handler(
		new Request(`${BASE}${path}`, {
			method: "POST",
			headers,
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	);
}

function get(
	handler: (request: Request) => Promise<Response>,
	path: string,
	init: { token?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
	return handler(
		new Request(`${BASE}${path}`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${init.token ?? TOKENS.acme}`,
				...(init.headers ?? {}),
			},
		}),
	);
}

interface Answer {
	ok: boolean;
	id?: string;
	command?: string;
	data?: JsonValue;
	error?: { code: string; message: string };
}

async function answerOf(response: Response): Promise<Answer> {
	return (await response.json()) as Answer;
}

async function startRun(handler: (request: Request) => Promise<Response>): Promise<string> {
	const response = await post(handler, "/v1/commands", {
		type: "command",
		id: "c1",
		command: "start",
		task: "test-task",
		input: "do it",
	});
	const answer = await answerOf(response);
	expect(answer.ok).toBe(true);
	return (answer.data as { session: string }).session;
}

/** The frames of a run read off an event stream, until it ends. */
async function streamed(response: Response): Promise<{ id: number | null; event: SessionEvent }[]> {
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const body = response.body;
	if (body === null) {
		throw new Error("the event stream had no body");
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
		if (text.includes('"type":"run_end"')) {
			await reader.cancel();
			break;
		}
	}
	return text
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.map((block) => {
			const lines = block.split("\n");
			const id = lines.find((line) => line.startsWith("id: "));
			const data = lines.find((line) => line.startsWith("data: "));
			return {
				id: id === undefined ? null : Number(id.slice(4)),
				event: JSON.parse(data?.slice(6) ?? "{}") as SessionEvent,
			};
		});
}

test("HTP01 a command comes back as a response frame, with the version", async () => {
	const host = createHost(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const handler = handlerFor(host);
	const response = await post(handler, "/v1/commands", {
		type: "command",
		id: "c1",
		command: "start",
		task: "test-task",
		input: "do it",
	});

	expect(response.status).toBe(200);
	expect(response.headers.get("x-lyra-version")).toBe("1");
	expect(await answerOf(response)).toMatchObject({
		ok: true,
		id: "c1",
		command: "start",
	});

	// The session id the start answered is the one the next command names.
	await until(() => host.model.requests.length === 1);
	const session = [...host.sessions.keys()][0];
	expect(session).toBeDefined();
	const state = await get(handler, `/v1/state?session=${session}`);
	expect(await answerOf(state)).toMatchObject({ ok: true, data: { state: "running" } });
	host.clock.advance(5_000);
});

test("HTP02 every error code maps to a status, and a refusal keeps its frame", async () => {
	// The map, in one place, because a client's retry policy reads it.
	expect(statusForCode("bad_request")).toBe(400);
	expect(statusForCode("permission_denied")).toBe(403);
	expect(statusForCode("not_found")).toBe(404);
	expect(statusForCode("busy")).toBe(409);
	expect(statusForCode("conflict")).toBe(409);
	expect(statusForCode("unsupported")).toBe(501);
	expect(statusForCode("timeout")).toBe(504);
	expect(statusForCode("provider_error")).toBe(502);
	expect(statusForCode("internal")).toBe(500);

	const host = createHost([]);
	const handler = handlerFor(host);
	const missing = await post(handler, "/v1/commands", {
		type: "command",
		id: "c1",
		command: "start",
		task: "no-such-task",
		input: "x",
	});
	expect(missing.status).toBe(404);
	expect(await answerOf(missing)).toMatchObject({
		ok: false,
		id: "c1",
		error: { code: "not_found" },
	});

	const unsupported = await post(handler, "/v1/commands", {
		type: "command",
		id: "c2",
		command: "list_sessions",
		session: "s1",
	});
	expect(unsupported.status).toBe(501);
	expect(await answerOf(unsupported)).toMatchObject({ error: { code: "unsupported" } });
});

test("HTP03 a body that is not one command, or is over the cap, is bad_request", async () => {
	const host = createHost([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const handler = handlerFor(host, { maxBodyBytes: 200 });

	const notJson = await post(handler, "/v1/commands", "this is not a frame");
	expect(notJson.status).toBe(400);
	expect(await answerOf(notJson)).toMatchObject({ error: { code: "bad_request" } });

	// A bad field is answered with the id and the command the client sent, so a
	// client can pair the refusal with its request.
	const badField = await post(handler, "/v1/commands", {
		type: "command",
		id: "c3",
		command: "start",
		task: 7,
		input: "do it",
	});
	expect(badField.status).toBe(400);
	expect(await answerOf(badField)).toMatchObject({
		ok: false,
		id: "c3",
		command: "start",
		error: { code: "bad_request" },
	});

	const tooBig = await post(handler, "/v1/commands", {
		type: "command",
		id: "c4",
		command: "start",
		task: "test-task",
		input: "x".repeat(400),
	});
	expect(tooBig.status).toBe(400);
	expect(await answerOf(tooBig)).toMatchObject({ error: { code: "bad_request" } });
	// Nothing ran: a refused body is not a command.
	expect(host.sessions.size).toBe(0);
});

test("HTP04 the version header is required to be one Lyra speaks", async () => {
	const host = createHost([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const handler = handlerFor(host);
	const command = {
		type: "command",
		id: "c1",
		command: "start",
		task: "test-task",
		input: "do it",
	};

	// Missing means one, which is what every client spoke before the header existed.
	expect((await post(handler, "/v1/commands", command)).status).toBe(200);
	const started = [...host.sessions.keys()][0];
	expect(started).toBeDefined();

	const wrong = await post(
		handler,
		"/v1/commands",
		{ ...command, key: "later" },
		{ headers: { "x-lyra-version": "2" } },
	);
	expect(wrong.status).toBe(501);
	expect(await answerOf(wrong)).toMatchObject({ error: { code: "unsupported" } });
	expect(host.sessions.size).toBe(1);
});

test("HTP05 an event stream replays from Last-Event-ID and carries each entry's seq", async () => {
	const host = createHost([
		{ toolCalls: [{ id: "c1", name: "finish" }] },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	]);
	const handler = handlerFor(host);
	const session = await startRun(handler);
	await until(() => host.sessions.get(session)?.session !== undefined);

	const first = await streamed(
		await get(handler, `/v1/events?session=${session}`, { headers: { "last-event-id": "0" } }),
	);
	expect(first.length).toBeGreaterThan(1);
	// Only entries after the one the client already has, in order, each with its seq.
	const ids = first.flatMap((frame) => (frame.id === null ? [] : [frame.id]));
	expect(ids.every((id) => id > 0)).toBe(true);
	expect([...ids].sort((a, b) => a - b)).toEqual(ids);
	// A live-only event is sent without an id, because a reconnect never replays it.
	const live = first.filter((frame) => frame.id === null);
	expect(live.length).toBeGreaterThan(0);
	expect(live.every((frame) => !("seq" in frame.event))).toBe(true);
	expect(first.at(-1)?.event).toMatchObject({ type: "run_end", reason: "done" });

	// A client that is already up to date is sent nothing old: the next thing it
	// reads is the next thing that happens, not a replay.
	const last = ids.at(-1) as number;
	const caughtUp = await get(handler, `/v1/events?session=${session}`, {
		headers: { "last-event-id": String(last) },
	});
	const body = caughtUp.body;
	expect(body).not.toBeNull();
	const reader = body?.getReader();
	await post(handler, "/v1/commands", {
		type: "command",
		id: "c2",
		command: "follow_up",
		session,
		text: "one more",
	});
	const next: { id: number | null; event: SessionEvent }[] = [];
	const decoder = new TextDecoder();
	let text = "";
	for (;;) {
		const chunk = await reader?.read();
		if (chunk === undefined || chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
		if (text.includes('"type":"run_end"')) {
			break;
		}
	}
	for (const block of text.split("\n\n").filter((part) => part.trim() !== "")) {
		const idLine = block.split("\n").find((line) => line.startsWith("id: "));
		const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
		next.push({
			id: idLine === undefined ? null : Number(idLine.slice(4)),
			event: JSON.parse(dataLine?.slice(6) ?? "{}") as SessionEvent,
		});
	}
	await reader?.cancel();
	expect(next.length).toBeGreaterThan(0);
	expect(next[0]?.id).toBeGreaterThan(last);
	expect(next.map((frame) => frame.id)).not.toContain(last);
});

test("HTP06 a client that stops reading is dropped, and a reconnect catches up", async () => {
	// A cap of one chunk, so the stream is dropped before a run of this size ends.
	const host = createHost([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const handler = handlerFor(host, { maxQueuedEvents: 1 });
	const session = await startRun(handler);
	const again = await get(handler, `/v1/events?session=${session}`, {
		headers: { "last-event-id": "0" },
	});
	const body = again.body;
	expect(body).not.toBeNull();
	// Nothing is read from this stream at all while the run finishes writing.
	await until(() => false, 30);
	const reader = body?.getReader();
	let dropped = false;
	for (let attempt = 0; attempt < 20 && !dropped; attempt += 1) {
		const chunk = await reader?.read();
		dropped = chunk?.done === true;
	}

	// Whatever was dropped comes back from the record, in order and complete. The
	// reconnect uses the default cap: a replay arrives in one burst, so any cap
	// smaller than the record would drop a client that is reading.
	const patient = handlerFor(host);
	const caught = await streamed(
		await get(patient, `/v1/events?session=${session}`, { headers: { "last-event-id": "0" } }),
	);
	expect(caught.at(-1)?.event).toMatchObject({ type: "run_end", reason: "done" });
	const ids = caught.flatMap((frame) => (frame.id === null ? [] : [frame.id]));
	expect([...ids].sort((a, b) => a - b)).toEqual(ids);
	// The dropped stream left nothing behind: the record's run_start and run_end are
	// both here, in that order, so the client did not miss what it was dropped during.
	expect(caught.filter((frame) => frame.event.type === "run_start")).toHaveLength(1);
	expect(caught.filter((frame) => frame.event.type === "run_end")).toHaveLength(1);
});

test("HTP07 the state route answers get_state, and an answer names its request", async () => {
	const host = createHost(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 5_000, clock), createFinishTool()],
	);
	const handler = handlerFor(host);
	const session = await startRun(handler);
	await until(() => host.model.requests.length === 1);

	const state = await get(handler, `/v1/state?session=${session}`);
	expect(state.status).toBe(200);
	expect(await answerOf(state)).toMatchObject({
		ok: true,
		data: { session, run: expect.any(String), state: "running" },
	});

	// An answer to a request this session never asked is `not_found`, and the frame
	// says what it was about so a client can pair it.
	const approval = await post(handler, "/v1/ui_response", {
		type: "ui_response",
		id: "f1",
		request: "u1",
		session,
		ok: true,
	});
	expect(approval.status).toBe(404);
	expect(await answerOf(approval)).toMatchObject({
		ok: false,
		id: "f1",
		command: "ui_response",
		error: { code: "not_found" },
	});
	host.clock.advance(5_000);
});

test("HTP08 another path or method is not_found, as a frame", async () => {
	const host = createHost([]);
	const handler = handlerFor(host);
	const unknown = await get(handler, "/v1/nope");
	expect(unknown.status).toBe(404);
	expect(await answerOf(unknown)).toMatchObject({ ok: false, error: { code: "not_found" } });

	const wrongMethod = await post(handler, "/v1/events", { type: "command" });
	expect(wrongMethod.status).toBe(404);
});

test("ACC02 a request without a token is refused", async () => {
	const host = createHost([]);
	const handler = handlerFor(host);
	const response = await get(handler, "/v1/state?session=s1", { token: "not-a-token" });
	expect(response.status).toBe(403);
	expect(await answerOf(response)).toMatchObject({
		ok: false,
		error: { code: "permission_denied" },
	});

	const none = await handler(
		new Request(`${BASE}/v1/state?session=s1`, { method: "GET", headers: {} }),
	);
	expect(none.status).toBe(403);
});

test("ACC01 another tenant's session is not_found, and does not leak", async () => {
	const host = createHost([{ toolCalls: [{ id: "c1", name: "finish" }] }]);
	const handler = handlerFor(host);
	const started = await post(handler, "/v1/commands", {
		type: "command",
		id: "c1",
		command: "start",
		task: "test-task",
		input: "do it",
		key: "job-1",
	});
	expect((await answerOf(started)).ok).toBe(true);
	const named = [...host.sessions.keys()][0];
	expect(named).toBeDefined();

	const intruder = await get(handler, `/v1/state?session=${named}`, { token: TOKENS.other });
	expect(intruder.status).toBe(404);
	const answer = await answerOf(intruder);
	expect(answer).toMatchObject({ error: { code: "not_found" } });
	// The refusal must not say whose session it is.
	expect(JSON.stringify(answer)).not.toContain("acme");
});

test("REQ02 an approval parks a run over HTTP, and the answer finishes it", async () => {
	const host = createHost(
		[
			{ toolCalls: [{ id: "c1", name: "write", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
		],
		() => [toolReturning("write", "wrote one line", { policy: "ask" }), createFinishTool()],
	);
	const handler = handlerFor(host);
	const session = await startRun(handler);

	/**
	 * Ask the session rather than reading its storage: over HTTP the commands and
	 * their answers are all a client has, so they are all this test uses.
	 */
	const pendingRequest = async (): Promise<string | undefined> => {
		const listed = await post(handler, "/v1/commands", {
			type: "command",
			id: "c-pending",
			command: "list_pending",
			session,
		});
		const answer = await answerOf(listed);
		const requests = isPlainObject(answer.data) ? answer.data["requests"] : undefined;
		const first = Array.isArray(requests) ? requests[0] : undefined;
		return isPlainObject(first) && typeof first["request"] === "string"
			? first["request"]
			: undefined;
	};
	await until(() => host.model.requests.length === 1);
	let request = await pendingRequest();
	for (let tick = 0; tick < 200 && request === undefined; tick += 1) {
		await Promise.resolve();
		request = await pendingRequest();
	}
	expect(request).toBeDefined();

	const answered = await post(handler, "/v1/ui_response", {
		type: "ui_response",
		id: "f1",
		request,
		session,
		ok: true,
	});
	expect(answered.status).toBe(200);
	const stateNow = async (): Promise<string> => {
		const state = await get(handler, `/v1/state?session=${session}`);
		const answer = await answerOf(state);
		const value = isPlainObject(answer.data) ? answer.data["state"] : undefined;
		return typeof value === "string" ? value : "";
	};
	for (let tick = 0; tick < 200 && (await stateNow()) !== "done"; tick += 1) {
		await Promise.resolve();
	}
	expect(await stateNow()).toBe("done");

	// The same answer again is a conflict, and an unknown request is not found.
	const again = await post(handler, "/v1/ui_response", {
		type: "ui_response",
		id: "f2",
		request,
		session,
		ok: true,
	});
	expect(again.status).toBe(409);
	const unknown = await post(handler, "/v1/ui_response", {
		type: "ui_response",
		id: "f3",
		request: "auth-nope",
		session,
		ok: true,
	});
	expect(unknown.status).toBe(404);
});
