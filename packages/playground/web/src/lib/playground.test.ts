import { expect, test } from "vitest";

import {
	EMPTY_TRANSCRIPT,
	callState,
	clearToken,
	readRecord,
	readToken,
	reduce,
	saveToken,
	sendCommand,
	startRun,
	watchEvents,
	type Fetcher,
	type StreamEvent,
	type TokenStorage,
} from "./playground.js";

/**
 * The rows are in `docs/playground.md`: PGS08 to PGS10.
 *
 * These run on Node with no DOM: the token storage, the command and the stream are all
 * things the page passes in, which is the point of keeping the logic out of the
 * components. The component tests drive the same functions through the rendered page.
 */

function storage(initial?: string): TokenStorage & { held: Map<string, string> } {
	const held = new Map<string, string>();
	if (initial !== undefined) {
		held.set("lyra-playground-token", initial);
	}
	return {
		held,
		getItem: (key) => held.get(key) ?? null,
		setItem: (key, value) => {
			held.set(key, value);
		},
		removeItem: (key) => {
			held.delete(key);
		},
	};
}

/** A frame the command surface sends back, as JSON. */
function frameResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A stream that sends these events as SSE, one block each. */
function sseBody(events: readonly StreamEvent[], id = 1): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	const text = events.map((event) => `id: ${id++}\ndata: ${JSON.stringify(event)}\n\n`).join("");
	return new ReadableStream({
		start(controller) {
			controller.enqueue(encoder.encode(text));
			controller.close();
		},
	});
}

test("PGS08 the token is kept, trimmed and cleared on its own", () => {
	const store = storage();
	expect(readToken(store)).toBeUndefined();

	saveToken(store, "  a-token-for-a-test  ");
	expect(readToken(store)).toBe("a-token-for-a-test");

	// A blank box is not a token: saving nothing would overwrite a good one with "".
	saveToken(store, "   ");
	expect(readToken(store)).toBe("a-token-for-a-test");

	clearToken(store);
	expect(readToken(store)).toBeUndefined();
});

test("PGS08 starting a run sends one frame and hands back the run it opened", async () => {
	const seen: { url: string; headers: Record<string, string>; body: string }[] = [];
	const fetcher: Fetcher = async (url, init) => {
		seen.push({ url, headers: init?.headers ?? {}, body: init?.body ?? "" });
		return frameResponse({
			type: "response",
			id: "c1",
			command: "start",
			ok: true,
			data: { session: "s_1", run: "r_1" },
		});
	};

	const started = await startRun({
		base: "https://playground.test",
		token: "a-token-for-a-test",
		task: "tool-table",
		input: "what is 6 times 7",
		fetcher,
	});

	expect(started.ok).toBe(true);
	if (!started.ok) {
		return;
	}
	expect(started.value).toEqual({ session: "s_1", run: "r_1" });
	expect(seen[0]?.url).toBe("https://playground.test/v1/commands");
	expect(seen[0]?.headers["authorization"]).toBe("Bearer a-token-for-a-test");
	const body = JSON.parse(seen[0]?.body ?? "{}");
	expect(body.type).toBe("command");
	expect(body.command).toBe("start");
	expect(body.task).toBe("tool-table");
	expect(body.input).toBe("what is 6 times 7");
	// No session is named: the object the token opens is the session, and the answer says
	// which one it is, so the page can follow the stream.
	expect(body.session).toBeUndefined();
});

test("PGS09 a wrong token is a 403 the page can act on, not a message", async () => {
	const fetcher: Fetcher = async () =>
		frameResponse(
			{
				type: "response",
				id: "",
				command: "start",
				ok: false,
				error: {
					code: "permission_denied",
					message: "that token is not one this host knows",
				},
			},
			403,
		);

	const started = await startRun({
		base: "",
		token: "wrong",
		task: "tool-table",
		input: "hello",
		fetcher,
	});

	expect(started.ok).toBe(false);
	if (started.ok) {
		return;
	}
	expect(started.error.status).toBe(403);
	expect(started.error.code).toBe("permission_denied");
});

test("PGS09 a network that refuses is an error the page shows, not a crash", async () => {
	const fetcher: Fetcher = async () => {
		throw new Error("offline");
	};

	const started = await startRun({
		base: "",
		token: "t",
		task: "tool-table",
		input: "",
		fetcher,
	});

	expect(started.ok).toBe(false);
	if (started.ok) {
		return;
	}
	expect(started.error.code).toBe("network_error");
	expect(started.error.message).toBe("offline");
});

test("PGS09 an answer with no session is refused rather than half-used", async () => {
	const fetcher: Fetcher = async () =>
		frameResponse({ type: "response", ok: true, data: { run: "r_1" } });

	const started = await startRun({
		base: "",
		token: "t",
		task: "tool-table",
		input: "",
		fetcher,
	});

	expect(started.ok).toBe(false);
});

test("PGS10 the stream is read as events, in order, and a stop is not an error", async () => {
	const events: StreamEvent[] = [
		{ type: "run_start", run: "r_1" },
		{ type: "message_end", text: "hello", toolCalls: [] },
		{ type: "run_end", reason: "done", turn: 1, usage: { inputTokens: 1, outputTokens: 1 } },
	];
	const seen: StreamEvent[] = [];

	const result = await watchEvents({
		base: "https://playground.test",
		token: "a-token-for-a-test",
		session: "s 1",
		fetcher: async (url, init) => {
			// The session is a query parameter, and the token is a header: an EventSource
			// could not send one, which is why this path is a fetch.
			expect(url).toBe("https://playground.test/v1/events?session=s%201");
			expect(init?.headers?.["authorization"]).toBe("Bearer a-token-for-a-test");
			expect(init?.headers?.["accept"]).toBe("text/event-stream");
			return new Response(sseBody(events), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		},
		signal: new AbortController().signal,
		onEvent: (event) => seen.push(event),
	});

	expect(result.ok).toBe(true);
	expect(seen.map((event) => event["type"])).toEqual(["run_start", "message_end", "run_end"]);
});

test("PGS10 an unreadable event does not stop the ones after it", async () => {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			// A comment, a block that is not JSON, then a real event: the page must draw
			// the one that arrived rather than give up on the stream.
			controller.enqueue(encoder.encode(": keep-alive\n\n"));
			controller.enqueue(encoder.encode('data: {"type":\n\n'));
			controller.enqueue(encoder.encode('data: {"type":"run_end","reason":"done"}\n\n'));
			controller.close();
		},
	});
	const seen: StreamEvent[] = [];

	const result = await watchEvents({
		base: "",
		token: "t",
		session: "s_1",
		fetcher: async () => new Response(body, { status: 200 }),
		signal: new AbortController().signal,
		onEvent: (event) => seen.push(event),
	});

	expect(result.ok).toBe(true);
	expect(seen).toEqual([{ type: "run_end", reason: "done" }]);
});

test("PGS09 a stream refused for its token is a 403 the page can act on", async () => {
	const result = await watchEvents({
		base: "",
		token: "wrong",
		session: "s_1",
		fetcher: async () =>
			frameResponse(
				{
					type: "response",
					ok: false,
					error: { code: "permission_denied", message: "no" },
				},
				403,
			),
		signal: new AbortController().signal,
		onEvent: () => undefined,
	});

	expect(result.ok).toBe(false);
	if (result.ok) {
		return;
	}
	expect(result.error.status).toBe(403);
	expect(result.error.code).toBe("permission_denied");
});

test("PGS10 the transcript keeps the model's text, its calls and their results in order", () => {
	let transcript = reduce(EMPTY_TRANSCRIPT, { type: "run_start", run: "r_1" });
	transcript = reduce(transcript, {
		type: "message_end",
		text: "let me look",
		reasoning: "the person asked for the time",
		toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
	});
	transcript = reduce(transcript, {
		type: "tool_call",
		ts: 1_000,
		call: { id: "c1", name: "now", arguments: "{}" },
	});
	transcript = reduce(transcript, {
		type: "tool_end",
		ts: 1_120,
		callId: "c1",
		name: "now",
		isError: false,
		content: "2026-11-25T00:00:00.000Z",
	});
	transcript = reduce(transcript, {
		type: "run_end",
		reason: "done",
		turn: 2,
		usage: {
			inputTokens: 10,
			outputTokens: 5,
			cost: { amount: 0.002, currency: "USD", source: "provider" },
		},
	});

	// The call and its result are one row: a group of calls is a list, and a result
	// cannot be drawn before the call it answers.
	expect(transcript.rows.map((row) => row.kind)).toEqual(["assistant", "tool"]);
	expect(transcript.rows[0]).toMatchObject({
		text: "let me look",
		reasoning: "the person asked for the time",
	});
	expect(transcript.rows[1]).toMatchObject({
		name: "now",
		callId: "c1",
		arguments: "{}",
		result: "2026-11-25T00:00:00.000Z",
		isError: false,
		// The two record entries' own times, so a live run and a rebuild agree (PGS25).
		durationMs: 120,
	});
	expect(transcript.status).toEqual({ state: "done", turns: 2, costUsd: 0.002 });
});

test("PGS10 a parked run says why, and an error event becomes a row", () => {
	let transcript = reduce(EMPTY_TRANSCRIPT, {
		type: "run_end",
		reason: "parked",
		turn: 1,
		parkedReason: "model_unavailable",
		detail: "permission_denied: the secret is not available",
		usage: { inputTokens: 0, outputTokens: 0 },
	});
	expect(transcript.status.state).toBe("parked");
	expect(transcript.status.detail).toBe("permission_denied: the secret is not available");

	transcript = reduce(transcript, {
		type: "error",
		error: { code: "provider_error", message: "the provider dropped the stream" },
	});
	expect(transcript.rows).toEqual([{ kind: "problem", text: "the provider dropped the stream" }]);
	// A reply that reported no cost leaves the number absent rather than claiming zero,
	// which is the same rule the day cap uses (LIM05).
	expect(transcript.status.costUsd).toBeUndefined();
});

test("PGS10 an event the page has no rule for changes nothing", () => {
	const before = reduce(EMPTY_TRANSCRIPT, { type: "message_end", text: "hello", toolCalls: [] });
	const after = reduce(before, { type: "something_new", value: 1 });
	expect(after).toBe(before);
});

test("PGS22 a stream reopens at the last entry it drew, and reports where it got to", async () => {
	const asked: (Record<string, string> | undefined)[] = [];
	const seen: StreamEvent[] = [];
	const result = await watchEvents({
		base: "",
		token: "t",
		session: "s_1",
		lastEventId: "4",
		fetcher: async (_url, init) => {
			asked.push(init?.headers);
			return new Response(sseBody([{ type: "run_end", reason: "done" }], 5), { status: 200 });
		},
		signal: new AbortController().signal,
		onEvent: (event) => seen.push(event),
	});

	// The header is what the protocol replays from (HTP05): without it a reopened stream
	// sends the whole record again and the page draws every row twice.
	expect(asked[0]?.["last-event-id"]).toBe("4");
	expect(seen).toHaveLength(1);
	expect(result).toEqual({ ok: true, lastEventId: "5" });
});

test("PGS21 a steer, a follow-up and a stop each send their own frame", async () => {
	const sent: unknown[] = [];
	const fetcher: Fetcher = async (_url, init) => {
		sent.push(JSON.parse(String(init?.body)));
		return frameResponse({ type: "response", ok: true, data: {} });
	};

	for (const command of ["steer", "follow_up", "abort"] as const) {
		const result = await sendCommand({
			base: "",
			token: "t",
			fetcher,
			command,
			session: "s_1",
			id: `c-${command}`,
			...(command === "abort" ? {} : { text: "  go on  " }),
		});
		expect(result).toEqual({ ok: true });
	}

	expect(sent).toEqual([
		{ type: "command", id: "c-steer", command: "steer", session: "s_1", text: "  go on  " },
		{
			type: "command",
			id: "c-follow_up",
			command: "follow_up",
			session: "s_1",
			text: "  go on  ",
		},
		// A stop carries no text: `abort` takes a session and nothing else (CMD06).
		{ type: "command", id: "c-abort", command: "abort", session: "s_1" },
	]);
});

test("PGS21 a command with nothing to act on is a refusal the page can show", async () => {
	const result = await sendCommand({
		base: "",
		token: "t",
		fetcher: async () =>
			frameResponse(
				{
					type: "response",
					ok: false,
					error: { code: "conflict", message: "nothing is running" },
				},
				409,
			),
		command: "abort",
		session: "s_1",
		id: "c1",
	});
	expect(result).toEqual({
		ok: false,
		error: { code: "conflict", message: "nothing is running", status: 409 },
	});
});

test("PGS23 the record is read one page at a time, and a malformed answer is a message", async () => {
	const asked: unknown[] = [];
	const page = await readRecord({
		base: "",
		token: "t",
		fetcher: async (_url, init) => {
			asked.push(JSON.parse(String(init?.body)));
			return frameResponse({
				type: "response",
				ok: true,
				data: { entries: [{ type: "header", id: "e1" }, "not an entry"], cursor: "e1" },
			});
		},
		session: "s_1",
		limit: 20,
		id: "c1",
	});

	expect(page).toEqual({
		ok: true,
		value: { entries: [{ type: "header", id: "e1" }], cursor: "e1" },
	});
	expect(asked[0]).toEqual({
		type: "command",
		id: "c1",
		command: "get_messages",
		session: "s_1",
		limit: 20,
	});

	const broken = await readRecord({
		base: "",
		token: "t",
		fetcher: async () => frameResponse({ type: "response", ok: true, data: { entries: "no" } }),
		session: "s_1",
		id: "c2",
	});
	expect(broken).toMatchObject({ ok: false, error: { code: "internal" } });
});

test("PGS24 a group of calls is several rows that fill in as the results arrive", () => {
	let transcript = reduce(EMPTY_TRANSCRIPT, {
		type: "message_end",
		text: "",
		toolCalls: [],
	});
	// One reply, two calls, and no result yet: both rows are drawn, which is what makes a
	// group visible while it is running. The group shares its entry's time.
	for (const call of [
		{ id: "a", name: "now", arguments: "{}" },
		{ id: "b", name: "calculator", arguments: '{"a":6,"b":7,"op":"*"}' },
	]) {
		transcript = reduce(transcript, { type: "tool_call", ts: 500, call });
	}
	expect(transcript.rows).toHaveLength(2);
	expect(transcript.rows.map((row) => row.kind === "tool" && row.result)).toEqual([
		undefined,
		undefined,
	]);

	// The faster one answers first; the other is still open, and the page can draw that.
	transcript = reduce(transcript, {
		type: "tool_end",
		ts: 560,
		callId: "b",
		name: "calculator",
		isError: false,
		content: "42",
	});
	expect(transcript.rows[1]).toMatchObject({ callId: "b", result: "42", durationMs: 60 });
	expect(transcript.rows[0]).toMatchObject({ callId: "a" });
	expect(transcript.rows[0]).not.toHaveProperty("result");

	// A tool that failed fills its own row as an error rather than a second row.
	transcript = reduce(transcript, {
		type: "tool_end",
		ts: 700,
		callId: "a",
		name: "now",
		isError: true,
		content: "the clock is unavailable",
	});
	expect(transcript.rows[0]).toMatchObject({
		callId: "a",
		result: "the clock is unavailable",
		isError: true,
		durationMs: 200,
	});
	expect(transcript.rows).toHaveLength(2);
});

test("PGS24 a result with no call, or a second result, changes nothing", () => {
	const once = reduce(EMPTY_TRANSCRIPT, {
		type: "tool_call",
		ts: 1,
		call: { id: "c1", name: "now" },
	});
	const answered = reduce(once, {
		type: "tool_end",
		ts: 2,
		callId: "c1",
		name: "now",
		isError: false,
		content: "first",
	});

	// A record that arrives out of order must not invent a row for a result the page
	// never saw a call for, and a duplicate result must not overwrite the first.
	expect(
		reduce(EMPTY_TRANSCRIPT, {
			type: "tool_end",
			ts: 2,
			callId: "ghost",
			name: "now",
			isError: false,
			content: "x",
		}),
	).toEqual(EMPTY_TRANSCRIPT);
	expect(
		reduce(answered, {
			type: "tool_end",
			ts: 3,
			callId: "c1",
			name: "now",
			isError: true,
			content: "second",
		}),
	).toEqual(answered);
});

test("PGS25 a duration is the record's own times, so a live run and a reload agree", () => {
	// The two times are the events' `ts`, which is the record entry's time. A page clock
	// would give a different number on every render and a different one after a reload;
	// these are the same 120 ms whichever way the run is read.
	const live = reduce(
		reduce(EMPTY_TRANSCRIPT, {
			type: "tool_call",
			ts: 4_000,
			call: { id: "c1", name: "now", arguments: "{}" },
		}),
		{ type: "tool_end", ts: 4_120, callId: "c1", name: "now", isError: false, content: "x" },
	);
	expect(live.rows[0]).toMatchObject({ at: 4_000, durationMs: 120 });

	// A call whose end carries no time is drawn without a duration rather than with a
	// number the page made up.
	const untimed = reduce(
		reduce(EMPTY_TRANSCRIPT, { type: "tool_call", call: { id: "c1", name: "now" } }),
		{ type: "tool_end", callId: "c1", name: "now", isError: false, content: "x" },
	);
	expect(untimed.rows[0]).toMatchObject({ result: "x" });
	expect(untimed.rows[0]).not.toHaveProperty("durationMs");
});

test("PGS24 a call's badge says what happened, and an unfinished call says so", () => {
	const call = reduce(EMPTY_TRANSCRIPT, {
		type: "tool_call",
		ts: 1,
		call: { id: "c1", name: "now" },
	});
	const row = call.rows[0];
	expect(row).toBeDefined();
	if (row === undefined) {
		return;
	}

	// While the run is going, the call is running; once the run has ended, a row with no
	// result is unfinished rather than running for ever (found in review on #89).
	expect(callState(row, "running")).toBe("running");
	for (const ended of ["done", "parked", "failed"] as const) {
		expect(callState(row, ended), ended).toBe("unfinished");
	}

	const answered = reduce(call, {
		type: "tool_end",
		ts: 2,
		callId: "c1",
		name: "now",
		isError: false,
		content: "x",
	}).rows[0];
	if (answered === undefined || answered.kind !== "tool") {
		return;
	}
	expect(callState(answered, "running")).toBe("done");
	expect(callState({ ...answered, isError: true }, "done")).toBe("error");
});
