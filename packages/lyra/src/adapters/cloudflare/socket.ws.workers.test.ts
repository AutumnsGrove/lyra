import { env } from "cloudflare:test";
import { expect, test } from "vitest";

/**
 * The socket's first slice (docs/implementation/08-websocket.md, WSK01 to WSK06):
 * the upgrade, the `hello` exchange, and a command carried as a frame.
 *
 * These files run with isolation off and one worker (decision 101), so storage is
 * shared between tests: every test makes its own session, and none assumes a record
 * is empty.
 */

const TOKENS = { acme: "tok-acme" };

function socketUrl(session: string, since?: number): string {
	const params = new URLSearchParams({ session });
	if (since !== undefined) {
		params.set("since", String(since));
	}
	return `https://lyra.test/v1/ws?${params.toString()}`;
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
				input: { turns: [{ calls: [{ name: "finish" }] }] },
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
async function connect(session: string, token: string | null = TOKENS.acme) {
	const response = await stub(session).fetch(
		new Request(socketUrl(session), {
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

/** The next frame the server sent, as JSON. */
function next(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
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

	const hello = await next(socket);
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
	await next(socket); // the server's hello

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
	await next(socket);
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
	await next(socket);
	socket.send(JSON.stringify({ type: "hello", version: "1", client: "test", capabilities: [] }));

	socket.send("this is not json");
	const notJson = await next(socket);
	expect(notJson).toMatchObject({ type: "response", ok: false });

	socket.send(JSON.stringify({ type: "nonsense" }));
	const unknown = await next(socket);
	expect(unknown).toMatchObject({ type: "response", ok: false });

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

test("WSK05 a frame over the line cap closes the socket with 1002", async () => {
	const session = await startOn(env.SESSION.newUniqueId().toString());
	const { socket } = await connect(session);
	if (socket === undefined) {
		throw new Error("the upgrade did not carry a socket");
	}
	await next(socket);
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
