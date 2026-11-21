import { env } from "cloudflare:workers";
import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import type { JsonValue } from "../../core/json.js";
import { loadRecord } from "../../record/load.js";
import fixture from "./testing/fixture-worker.testing.js";
import type { TestSession } from "./testing/session-class.testing.js";

/**
 * CFL22 to CFL26 in `docs/adapters.md`: the session object and the Worker that
 * routes to it, over the real runtime. Requests go through `exports.default.fetch`,
 * so what is tested is the wire a client would use, not a method.
 */

const TOKENS = { acme: "tok-acme", other: "tok-other" };

type Stub = ReturnType<typeof sessionStub>;

function sessionStub(id?: string) {
	return id === undefined
		? env.SESSION.get(env.SESSION.newUniqueId())
		: env.SESSION.get(env.SESSION.idFromString(id));
}

function worker(): (request: Request) => Promise<Response> {
	return async (request) => fixture.fetch(request, env);
}

/** Let the run reach the model, then go on. Workerd's promises turn as they do. */
async function until(check: () => Promise<boolean>, limit = 100): Promise<void> {
	for (let attempt = 0; attempt < limit; attempt += 1) {
		if (await check()) {
			return;
		}
		await new Promise<void>((resolve) => {
			void resolve;
		});
	}
	throw new Error("the condition never held");
}

function send(
	body: unknown,
	token: string = TOKENS.acme,
	path = "/v1/commands",
): Promise<Response> {
	const id = "c1";
	return worker()(
		new Request(`https://lyra.test${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
			body: JSON.stringify(
				typeof body === "string"
					? body
					: { type: "command", id, ...(body as Record<string, unknown>) },
			),
		}),
	);
}

function get(path: string, token: string = TOKENS.acme, lastEventId?: string): Promise<Response> {
	return worker()(
		new Request(`https://lyra.test${path}`, {
			method: "GET",
			headers: {
				authorization: `Bearer ${token}`,
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		}),
	);
}

interface Answer {
	ok: boolean;
	data?: JsonValue;
	error?: { code: string; message: string };
}

async function answerOf(response: Response): Promise<Answer> {
	return (await response.json()) as Answer;
}

async function startSession(
	script: { turns: { calls: { name: string; args?: JsonValue }[] }[] },
	key?: string,
): Promise<string> {
	const response = await send({
		command: "start",
		task: "test-task",
		input: script,
		...(key === undefined ? {} : { key }),
	});
	const answer = await answerOf(response);
	if (!answer.ok) {
		throw new Error(`the start was refused: ${JSON.stringify(answer)}`);
	}
	return (answer.data as { session: string }).session;
}

/** The events a session's record holds, read off its stream until it ends. */
async function eventsOf(session: string): Promise<{ id: number | null; type: string }[]> {
	const response = await get(`/v1/events?session=${session}`, TOKENS.acme, "0");
	expect(response.status).toBe(200);
	const body = response.body;
	if (body === null) {
		throw new Error("the stream had no body");
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
			break;
		}
	}
	await reader.cancel();
	return text
		.split("\n\n")
		.filter((block) => block.trim() !== "")
		.flatMap((block) => {
			const lines = block.split("\n");
			const id = lines.find((line) => line.startsWith("id: "));
			const data = lines.find((line) => line.startsWith("data: "));
			if (data === undefined) {
				return [];
			}
			const event = JSON.parse(data.slice(6)) as { type: string };
			return [{ id: id === undefined ? null : Number(id.slice(4)), type: event.type }];
		});
}

test("CFL22 a two-tool task runs from start to done over HTTP", async () => {
	// The session is created by the start itself: no id is chosen by the test.
	const script = {
		turns: [
			{ calls: [{ name: "read", args: { path: "a.md" } }] },
			{ calls: [{ name: "write", args: { path: "b.md" } }] },
			{ calls: [{ name: "finish", args: {} }] },
		],
	};
	const session = await startSession(script);
	expect(session).toMatch(/^[0-9a-f]{64}$/);

	const events = await eventsOf(session);
	expect(events.filter((event) => event.type === "run_start")).toHaveLength(1);
	expect(events.filter((event) => event.type === "run_end")).toHaveLength(1);
	// Two tools really ran, and the record says so.
	const stub = sessionStub(session);
	const lines = await runInDurableObject(stub, (instance: TestSession) => instance.lines());
	const loaded = loadRecord(lines);
	expect(loaded.ok).toBe(true);
	const results = (loaded.ok ? loaded.value.entries : []).filter(
		(entry) => entry.type === "tool_message",
	);
	expect(results.map((entry) => (entry.type === "tool_message" ? entry.content : ""))).toEqual([
		"the file",
		"written",
		"finished",
	]);
});

test("CFL23 a run killed mid-flight finishes through its alarm, over HTTP", async () => {
	const session = await startSession({
		turns: [{ calls: [{ name: "slow", args: {} }] }, { calls: [{ name: "finish", args: {} }] }],
	});
	const stub = sessionStub(session);

	// The run is in the slow tool when the object goes away.
	await until(async () => {
		const requests = await runInDurableObject(stub, (instance: TestSession) =>
			instance.requests(),
		);
		return requests > 0;
	});

	await evictDurableObject(stub);
	const fired = await runDurableObjectAlarm(stub);
	expect(fired).toBe(true);
	// The resumed run is waiting on the fresh instance's fake clock; letting it go
	// finishes the run, which the record then holds.
	await runInDurableObject(stub, (instance: TestSession) => {
		instance.advance(5_000);
	});

	const events = await eventsOf(session);
	// One segment ended parked? No: the slow call was interrupted, so the alarm
	// continues it, and the record's last word is a done segment.
	expect(events.filter((event) => event.type === "run_end").length).toBeGreaterThanOrEqual(1);
	const last = events.at(-1);
	expect(last?.type).toBe("run_end");
});

test("CFL24 a repeated start with a key lands on the same session", async () => {
	const script = { turns: [{ calls: [{ name: "finish", args: {} }] }] };
	const first = await startSession(script, "job-1");
	const again = await startSession(script, "job-1");
	expect(again).toBe(first);

	// The same key with a different job is a conflict, not a second run.
	const conflict = await send({
		command: "start",
		task: "test-task",
		input: { turns: [{ calls: [{ name: "read", args: {} }] }] },
		key: "job-1",
	});
	expect(conflict.status).toBe(409);
	expect(await answerOf(conflict)).toMatchObject({ error: { code: "conflict" } });

	// A different key is a different session.
	const other = await startSession(script, "job-2");
	expect(other).not.toBe(first);
});

test("CFL25 another tenant's session is not_found over HTTP, and leaves no trace", async () => {
	const session = await startSession(
		{ turns: [{ calls: [{ name: "finish", args: {} }] }] },
		"mine",
	);

	const intruder = await get(`/v1/state?session=${session}`, TOKENS.other);
	expect(intruder.status).toBe(404);
	const answer = await answerOf(intruder);
	expect(answer).toMatchObject({ error: { code: "not_found" } });
	expect(JSON.stringify(answer)).not.toContain("acme");
});

test("CFL26 the trusted door runs a command for a named tenant", async () => {
	const session = await startSession(
		{ turns: [{ calls: [{ name: "finish", args: {} }] }] },
		"trusted",
	);

	const response = await worker()(
		new Request("https://lyra.test/service", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				session,
				frame: JSON.stringify({
					type: "command",
					id: "s1",
					command: "get_state",
					session,
				}),
			}),
		}),
	);
	const answer = (await response.json()) as Answer;
	expect(answer).toMatchObject({ ok: true, data: { session } });
});
