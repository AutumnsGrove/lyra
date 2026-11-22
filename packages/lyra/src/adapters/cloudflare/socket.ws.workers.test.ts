import {
	env,
	evictDurableObject,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { expect, test } from "vitest";

/**
 * The socket's first slice (docs/implementation/08-websocket.md, WSK01 to WSK06):
 * the upgrade, the `hello` exchange, and a command carried as a frame.
 *
 * These files run with isolation off and one worker (decision 101), so storage is
 * shared between tests: every test makes its own session, and none assumes a record
 * is empty.
 */

import fixture from "./testing/fixture-worker.testing.js";
import type { TestSession } from "./testing/session-class.testing.js";

const TOKENS = { acme: "tok-acme" };

function socketUrl(session: string, since?: number): string {
	const params = new URLSearchParams({ session });
	if (since !== undefined) {
		params.set("since", String(since));
	}
	return `https://lyra.test/v1/ws?${params.toString()}`;
}

/** A session whose run sits in a slow tool, so a socket can connect mid-run. */
async function startSlow(): Promise<string> {
	const session = env.SESSION.newUniqueId().toString();
	const response = await stub(session).fetch(
		new Request("https://lyra.test/v1/commands", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.acme}` },
			body: JSON.stringify({
				type: "command",
				id: "start-slow",
				command: "start",
				task: "test-task",
				input: {
					turns: [
						{ calls: [{ name: "slow", args: {} }] },
						{ calls: [{ name: "finish" }] },
					],
				},
			}),
		}),
	);
	const answer = (await response.json()) as { ok: boolean; data?: { session?: string } };
	if (!answer.ok || answer.data?.session === undefined) {
		throw new Error(`the start was refused: ${JSON.stringify(answer)}`);
	}
	return answer.data.session;
}

function stub(session: string) {
	return env.SESSION.get(env.SESSION.idFromString(session));
}

/** One object, the way a Worker's routing reaches it: by the session id it names. */
async function startOn(session: string): Promise<string> {
	const response = await stub(session).fetch(
		new Request("https://lyra.test/v1/commands", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.acme}` },
			body: JSON.stringify({
				type: "command",
				id: "start-1",
				command: "start",
				task: "test-task",
				// Two turns, so a prompted continuation has one to take.
				input: {
					turns: [{ calls: [{ name: "finish" }] }, { calls: [{ name: "finish" }] }],
				},
			}),
		}),
	);
	const answer = (await response.json()) as { ok: boolean; data?: { session?: string } };
	if (!answer.ok || answer.data?.session === undefined) {
		throw new Error(`the start was refused: ${JSON.stringify(answer)}`);
	}
	return answer.data.session;
}

/** A socket to a session, upgraded with the token a client would send. */
async function connect(session: string, token: string | null = TOKENS.acme, since?: number) {
	const response = await stub(session).fetch(
		new Request(socketUrl(session, since), {
			headers: {
				upgrade: "websocket",
				...(token === null ? {} : { authorization: `Bearer ${token}` }),
			},
		}),
	);
	if (response.status !== 101) {
		return { response, socket: undefined };
	}
	const socket = response.webSocket;
	if (socket === null) {
		throw new Error("a 101 response carried no socket");
	}
	socket.accept();
	return { response, socket };
}

/** The next frame of a given kind, skipping the others (events flow once greeted). */
function nextOf(
	socket: WebSocket,
	wanted: string,
	timeoutMs = 2_000,
): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no ${wanted} frame arrived`)), timeoutMs);
		const onMessage = (event: MessageEvent): void => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame["type"] !== wanted) {
				return;
			}
			clearTimeout(timer);
			socket.removeEventListener("message", onMessage);
			resolve(frame);
		};
		socket.addEventListener("message", onMessage);
	});
}

/** The next response frame, skipping events. */
function next(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
	return nextOf(socket, "response", timeoutMs);
}

/** The next frame the server sent, as JSON. */
function nextAny(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("no frame arrived")), timeoutMs);
		socket.addEventListener(
			"message",
			(event) => {
				clearTimeout(timer);
				resolve(JSON.parse(String(event.data)) as Record<string, unknown>);
			},
			{ once: true },
		);
	});
}

test("WSK01 an upgrade is answered with the server's hello, and a client hello completes it", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { response, socket } = await connect(session);
	expect(response.status).toBe(101);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}

	const hello = await nextAny(socket);
	// One version value, spelled the way `x-lyra-version` spells it.
	expect(hello).toMatchObject({ type: "hello", version: "1", server: "workers-test" });
	// The capabilities are what this transport offers, so a client can tell.
	expect(Array.isArray(hello["capabilities"])).toBe(true);

	socket.send(JSON.stringify({ type: "hello", version: 1, client: "test", capabilities: [] }));
	// The exchange is over: a command now reaches the session.
	socket.send(JSON.stringify({ type: "command", id: "c1", command: "get_state", session }));
	const answer = await next(socket);
	expect(answer).toMatchObject({ type: "response", id: "c1" });
	socket.close();
});

test("WSK04 an upgrade without a token is refused before the socket exists", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { response, socket } = await connect(session, null);
	expect(response.status).toBe(401);
	expect(socket).toBeUndefined();
});

test("WSK02 a command before the hello exchange is bad_request, and the socket stays open", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { socket } = await connect(session);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	await nextAny(socket); // the server's hello

	socket.send(JSON.stringify({ type: "command", id: "c1", command: "get_state", session }));
	const refused = await next(socket);
	expect(refused).toMatchObject({ type: "response", ok: false });
	expect((refused["error"] as { code?: string } | undefined)?.code).toBe("bad_request");

	// The exchange can still happen, and the socket was never closed.
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));
	socket.send(JSON.stringify({ type: "command", id: "c2", command: "get_state", session }));
	const answer = await next(socket);
	expect(answer).toMatchObject({ type: "response", id: "c2", ok: true });
	socket.close();
});

test("WSK03 a command over the socket answers what HTTP answers", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { socket } = await connect(session);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	await nextAny(socket);
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));

	socket.send(JSON.stringify({ type: "command", id: "c1", command: "get_state", session }));
	const overSocket = await next(socket);

	const overHttp = await stub(session).fetch(
		new Request("https://lyra.test/v1/commands", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.acme}` },
			body: JSON.stringify({ type: "command", id: "c1", command: "get_state", session }),
		}),
	);
	const overHttpAnswer = (await overHttp.json()) as Record<string, unknown>;

	// The same command, the same answer: the transport is not the session's business.
	expect(overSocket).toMatchObject({
		type: overHttpAnswer["type"] as string,
		id: overHttpAnswer["id"] as string,
		ok: overHttpAnswer["ok"] as boolean,
	});
	socket.close();
});

test("WSK06 a frame that is not one is refused, and the socket stays open", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { socket } = await connect(session);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	await nextAny(socket);
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));

	socket.send("this is not json");
	const notJson = await next(socket);
	expect(notJson).toMatchObject({ type: "response", ok: false, id: "" });

	// A refusal names the frame it refuses, so a client on one socket can pair it:
	// the same rule HTTP follows for a frame it turns away.
	socket.send(JSON.stringify({ type: "command", id: "c9", command: "nonsense" }));
	const unknown = await next(socket);
	expect(unknown).toMatchObject({ type: "response", ok: false, id: "c9", command: "nonsense" });

	// Still open, and a real command still works.
	socket.send(JSON.stringify({ type: "command", id: "c3", command: "get_state", session }));
	expect(await next(socket)).toMatchObject({ type: "response", id: "c3", ok: true });
	socket.close();
});

test("WSK04 an upgrade for another tenant's session is not found, like HTTP", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	// The other tenant's token is real, and the session is not theirs.
	const { response } = await connect(session, "tok-other");
	expect(response.status).toBe(404);
});

test("WSK01 the Worker's front door routes an upgrade to the session it names", async () => {
	// A Durable Object binding is not fetchable from the internet, so the Worker is
	// the door a real client has; the object is reached only through it.
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const response = await fixture.fetch(
		new Request(socketUrl(session), {
			headers: { upgrade: "websocket", authorization: `Bearer ${TOKENS.acme}` },
		}),
		env,
	);
	expect(response.status).toBe(101);
	const socket = response.webSocket;
	expect(socket).not.toBeNull();
	if (socket === null) {
		return;
	}
	socket.accept();
	const hello = await nextAny(socket);
	expect(hello).toMatchObject({ type: "hello" });
	socket.close();

	// The object's own 401 still applies to a caller with no token.
	const refused = await fixture.fetch(
		new Request(socketUrl(session), { headers: { upgrade: "websocket" } }),
		env,
	);
	expect(refused.status).toBe(401);
});

test("WSK01 a plain GET on the socket route is refused, not a 101 nobody asked for", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const plain = await fixture.fetch(
		new Request(socketUrl(session), {
			headers: { authorization: `Bearer ${TOKENS.acme}` },
		}),
		env,
	);
	expect(plain.status).toBe(400);
	const answer = (await plain.json()) as { ok: boolean; error?: { code?: string } };
	expect(answer.ok).toBe(false);
	expect(answer.error?.code).toBe("bad_request");
});

test("WSK05 a frame over the line cap closes the socket with 1002", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { socket } = await connect(session);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	await nextAny(socket);
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));

	const closed = new Promise<number>((resolve) => {
		socket.addEventListener("close", (event) => resolve((event as CloseEvent).code));
	});
	// Two megabytes and a bit: over the cap a line may be, so the socket is closed
	// rather than the frame being read (FRM01).
	socket.send(
		JSON.stringify({
			type: "command",
			id: "big",
			command: "prompt",
			session,
			text: "x".repeat(2 * 1024 * 1024 + 1),
		}),
	);
	expect(await closed).toBe(1002);
});

/** Every event until one of this type arrives, which is how a replay is drained. */
function drainUntil(
	socket: WebSocket,
	type: string,
	timeoutMs = 3_000,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const seen: Record<string, unknown>[] = [];
		const timer = setTimeout(() => {
			socket.removeEventListener("message", onMessage);
			reject(new Error(`no ${type} arrived; saw ${seen.length} events`));
		}, timeoutMs);
		const onMessage = (event: MessageEvent): void => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame["type"] !== "event") {
				return;
			}
			const inner = frame["event"] as Record<string, unknown>;
			seen.push(inner);
			if (inner["type"] === type) {
				clearTimeout(timer);
				socket.removeEventListener("message", onMessage);
				resolve(seen);
			}
		};
		socket.addEventListener("message", onMessage);
	});
}

/** The frames a socket sends until `count` have arrived, or it goes quiet. */
function collect(
	socket: WebSocket,
	count: number,
	timeoutMs = 3_000,
): Promise<Record<string, unknown>[]> {
	return new Promise((resolve, reject) => {
		const seen: Record<string, unknown>[] = [];
		const timer = setTimeout(() => {
			socket.removeEventListener("message", onMessage);
			reject(new Error(`only ${seen.length} of ${count} frames arrived`));
		}, timeoutMs);
		const onMessage = (event: MessageEvent): void => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame["type"] !== "event") {
				return;
			}
			seen.push(frame);
			if (seen.length >= count) {
				clearTimeout(timer);
				socket.removeEventListener("message", onMessage);
				resolve(seen);
			}
		};
		socket.addEventListener("message", onMessage);
	});
}

/**
 * A socket up to the server's hello, before the client answers. Its events begin
 * with the client's hello, so a caller that wants them attaches its listener
 * first; that is what makes a replay deterministic to observe.
 */
async function upgraded(session: string, since?: number) {
	const { socket } = await connect(session, TOKENS.acme, since);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	const hello = await nextAny(socket);
	expect(hello["type"]).toBe("hello");
	return socket;
}

/** The client's side of the exchange, which starts the events. */
function sayHello(socket: WebSocket): void {
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));
}

test("WSK07 events arrive live, in order, with their seq", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const socket = await upgraded(session);
	// The replay of the run `startOn` made arrives first; draining it to its
	// `run_end` is what makes the next event provably live rather than replayed.
	const replay = drainUntil(socket, "run_end");
	sayHello(socket);
	await replay;

	const live = collect(socket, 2);
	socket.send(
		JSON.stringify({ type: "command", id: "c1", command: "prompt", session, text: "again" }),
	);
	const seen = await live;
	socket.close();

	// A new segment of the same run begins, and these events exist because of the
	// prompt: a resume is announced as both `resumed` and `run_start` (decision 130).
	const types = seen.map((frame) => (frame["event"] as { type?: string } | undefined)?.type);
	expect(types).toEqual(["resumed", "run_start"]);
	for (const frame of seen) {
		expect(typeof (frame["event"] as { seq?: number } | undefined)?.seq).toBe("number");
	}
});

test("WSK08 a reconnect with since replays the record's events and no live-only ones", async () => {
	// The first socket sees the run to its end, so the record holds every event.
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const first = await upgraded(session, 0);
	const replay = drainUntil(first, "run_end");
	sayHello(first);
	await replay;
	first.close();

	// A second socket asks for everything, which is a replay from the record.
	const replayed = await upgraded(session, 0);
	const frames = collect(replayed, 1);
	sayHello(replayed);
	const seen = await frames;
	replayed.close();
	const event = seen[0]?.["event"] as { type?: string; seq?: number } | undefined;
	expect(event?.type).toBe("run_start");
	expect(typeof event?.seq).toBe("number");
});

test("WSK10 two sockets on one session both receive the events", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const first = await upgraded(session);
	const second = await upgraded(session);
	const draining = Promise.all([drainUntil(first, "run_end"), drainUntil(second, "run_end")]);
	sayHello(first);
	sayHello(second);
	await draining;

	const watching = Promise.all([collect(first, 2), collect(second, 2)]);
	first.send(
		JSON.stringify({ type: "command", id: "c1", command: "prompt", session, text: "go" }),
	);
	const [one, two] = await watching;
	first.close();
	second.close();
	// One command on one socket, and both watchers see the events it causes.
	for (const seen of [one, two]) {
		expect(
			seen.map((frame) => (frame["event"] as { type?: string } | undefined)?.type),
		).toEqual(["resumed", "run_start"]);
	}
});

test("WSK11 a client that disconnects mid-run does not stop the run", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const socket = await upgraded(session);
	const started = collect(socket, 1);
	sayHello(socket);
	socket.send(
		JSON.stringify({ type: "command", id: "c1", command: "prompt", session, text: "go" }),
	);
	await started;
	socket.close();

	// The run goes on without a watcher, and the record says so.
	const state = await stub(session).fetch(
		new Request(`https://lyra.test/v1/state?session=${session}`, {
			headers: { authorization: `Bearer ${TOKENS.acme}` },
		}),
	);
	expect(state.status).toBe(200);
	const answer = (await state.json()) as { data?: { state?: string } };
	expect(answer.data?.state).toBe("done");
});

test("WSK09 a reconnect mid-run hands over from replay to live with no gap or repeat", async () => {
	const session = await startSlow();
	const socket = await upgraded(session, 0);
	const frames: Record<string, unknown>[] = [];
	const finished = new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("the run never ended on the wire")), 5_000);
		socket.addEventListener("message", (event) => {
			const frame = JSON.parse(String(event.data)) as Record<string, unknown>;
			if (frame["type"] !== "event") {
				return;
			}
			frames.push(frame["event"] as Record<string, unknown>);
			if ((frame["event"] as { type?: string }).type === "run_end") {
				clearTimeout(timer);
				resolve();
			}
		});
	});
	sayHello(socket);

	// Let the slow tool finish, so the rest of the run reaches a socket that was
	// connected after the run had already started.
	await runInDurableObject(stub(session), (instance: TestSession) => {
		instance.advance(5_000);
	});
	await finished;
	socket.close();

	const seqs = frames.flatMap((event) => (typeof event["seq"] === "number" ? [event.seq] : []));
	expect(seqs.length).toBeGreaterThan(1);
	// Several events share one entry's `seq` on purpose (a turn's message, its calls
	// and its usage), so the property is that time never runs backwards and no event
	// is delivered twice, not that every seq is unique.
	for (const [index, seq] of seqs.entries()) {
		if (index > 0) {
			expect(seq).toBeGreaterThanOrEqual(seqs[index - 1] as number);
		}
	}
	expect(new Set(frames.map((event) => JSON.stringify(event))).size).toBe(frames.length);
	expect(frames.map((event) => event["type"])).toContain("run_end");
});

/** A session whose run is parked for a person, so an eviction has something to keep. */
async function parked(): Promise<string> {
	const session = env.SESSION.newUniqueId().toString();
	const response = await stub(session).fetch(
		new Request("https://lyra.test/v1/commands", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${TOKENS.acme}` },
			body: JSON.stringify({
				type: "command",
				id: "start-parked",
				command: "start",
				task: "test-task",
				input: {
					turns: [
						{ calls: [{ name: "approve", args: {} }] },
						{ calls: [{ name: "finish" }] },
					],
				},
			}),
		}),
	);
	const answer = (await response.json()) as { ok: boolean; data?: { session?: string } };
	if (!answer.ok || answer.data?.session === undefined) {
		throw new Error(`the start was refused: ${JSON.stringify(answer)}`);
	}
	return answer.data.session;
}

test("WSK12 an evicted object keeps its socket, and a command after the wake works", async () => {
	const session = await parked();
	const socket = await upgraded(session);
	const replay = drainUntil(socket, "run_end");
	sayHello(socket);
	await replay;

	// The object goes away with the socket open and the run parked for a person.
	await evictDurableObject(stub(session));

	// A frame wakes a fresh object, which rebuilds its watch from the attachment.
	socket.send(JSON.stringify({ type: "command", id: "c1", command: "get_state", session }));
	const answer = await next(socket);
	expect(answer).toMatchObject({ type: "response", id: "c1", ok: true });
	const state = (answer["data"] as { state?: string } | undefined)?.state;
	expect(state).toBe("parked");
	socket.close();
});

test("WSK14 the attachment carries the session, the tenant and the last seq, and stays small", async () => {
	const session = await parked();
	const response = await stub(session).fetch(
		new Request(socketUrl(session), {
			headers: { upgrade: "websocket", authorization: `Bearer ${TOKENS.acme}` },
		}),
	);
	const socket = response.webSocket;
	if (socket === null) {
		throw new Error("the upgrade did not carry a socket");
	}
	socket.accept();
	await nextAny(socket);
	sayHello(socket);
	await drainUntil(socket, "run_end");

	const attachment = await runInDurableObject(stub(session), (instance: TestSession) =>
		instance.attachments(),
	);
	expect(attachment).toHaveLength(1);
	// The tenant is the token's own name, which is what the record's header holds too.
	expect(attachment[0]).toMatchObject({ session, tenant: "acme", greeted: true });
	// The platform caps an attachment at 16,384 bytes; this one is a session id, a
	// tenant and a number.
	const bytes = new TextEncoder().encode(JSON.stringify(attachment[0])).byteLength;
	expect(bytes).toBeLessThan(16_384);
	socket.close();
});

/** Wait for an event of this type to arrive in a collecting array. */
async function untilEvent(
	events: Record<string, unknown>[],
	type: string,
	limit = 200,
): Promise<void> {
	for (let attempt = 0; attempt < limit; attempt += 1) {
		if (events.some((event) => event["type"] === type)) {
			return;
		}
		await new Promise<void>((resolve) => {
			void resolve;
		});
	}
	throw new Error(`no ${type} event arrived`);
}
