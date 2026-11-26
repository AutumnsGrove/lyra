import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterAll, afterEach, beforeEach, expect, test, vi } from "vitest";

import Page from "./+page.svelte";

/**
 * The rows are in `docs/playground.md`: PGS08 to PGS10 and PGS17 to PGS23, seen through
 * the page a person loads.
 *
 * These render the real component into `happy-dom` — a Node document, not a browser — so
 * what they prove is the wiring the library tests cannot: that the token box is what a
 * person without a token sees, that a conversation's record becomes its transcript, and
 * that a refused token sends them back to the box.
 */

const TOKEN_KEY = "lyra-playground-token";

interface Route {
	method: string;
	path: string;
	answer: (body: unknown) => Response;
}

/** The routes the page calls, replaced per test, and what it asked for. */
let routes: Route[] = [];
let calls: { method: string; path: string; body?: unknown }[] = [];

/** A stubbed `fetch`: installed for the whole file, because the page keeps asking. */
function installFetch(): void {
	vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
		const parsed = new URL(String(url), "http://localhost");
		const method = init?.method ?? "GET";
		const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
		calls.push({ method, path: parsed.pathname, ...(body === undefined ? {} : { body }) });
		const route = routes.find(
			(entry) => entry.method === method && entry.path === parsed.pathname,
		);
		if (route === undefined) {
			return new Response(
				JSON.stringify({ error: { code: "not_found", message: "no route" } }),
				{
					status: 404,
				},
			);
		}
		return route.answer(body);
	});
}

function stubFetch(entries: Route[]): {
	calls: { method: string; path: string; body?: unknown }[];
} {
	calls = [];
	routes = entries;
	return { calls };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function sse(events: readonly Record<string, unknown>[], id = 1): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(
					encoder.encode(`id: ${id++}\ndata: ${JSON.stringify(event)}\n\n`),
				);
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function started(session = "s_1", run = "r_1"): Response {
	return json({ type: "response", ok: true, data: { session, run } });
}

function frame(): Response {
	return json({ type: "response", ok: true, data: {} });
}

/** The routes every page with a token calls on load, before anything is clicked. */
function loaded(overrides: Route[] = []): Route[] {
	// Overrides first, because `find` answers with the first route that matches and a
	// test's own list or refusal is the one it means.
	return [
		...overrides,
		{
			method: "GET",
			path: "/api/recipes",
			answer: () => json({ recipes: ["tool-table", "shell"] }),
		},
		{ method: "GET", path: "/api/sessions", answer: () => json({ sessions: [] }) },
	];
}

beforeEach(() => {
	window.localStorage.clear();
	window.history.replaceState(null, "", "/");
	routes = [];
	calls = [];
	installFetch();
});

afterEach(() => {
	// The library only unmounts automatically when its own globals are on, and this
	// config keeps vitest's globals off. Without this the second test finds two pages.
	cleanup();
	routes = [];
	window.history.replaceState(null, "", "/");
});

afterAll(() => {
	vi.unstubAllGlobals();
});

test("PGS08 a person without a token sees only the token box", async () => {
	render(Page);

	// The mounted check runs before the first render, so the box is what the page settles
	// on: the transcript and the question are not there to be found.
	const field = await screen.findByLabelText("Token");
	expect(field.getAttribute("type")).toBe("password");
	expect(screen.queryByLabelText("Ask Lyra")).toBeNull();
});

test("PGS08 a token is saved before the page will run anything", async () => {
	stubFetch(loaded());
	render(Page);

	const field = await screen.findByLabelText("Token");
	await fireEvent.input(field, { target: { value: "  a-token-for-a-test  " } });
	await fireEvent.click(screen.getByRole("button", { name: "Open" }));

	// Trimmed on the way in, and kept where the next load will find it.
	await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBe("a-token-for-a-test"));
	expect(await screen.findByLabelText("Ask Lyra")).toBeTruthy();
});

test("PGS17 the first message mints a conversation, names it in the URL and starts it", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	const stubbed = stubFetch(
		loaded([
			{
				method: "POST",
				path: "/api/sessions",
				answer: () => json({ session: "s_new" }, 201),
			},
			{ method: "POST", path: "/v1/commands", answer: () => started("s_new") },
			{ method: "GET", path: "/v1/events", answer: () => sse([]) },
		]),
	);
	render(Page);

	const field = await screen.findByLabelText("Ask Lyra");
	// The picker arrives with the recipes, and the Run button waits for one: a run with
	// no recipe is a request the Worker would refuse.
	await screen.findByRole("option", { name: "tool-table" });
	await fireEvent.input(field, { target: { value: "what time is it?" } });
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// The conversation is created first, with the recipe the picker offered and the
	// person's own words as its label, and the run then names the id it was given.
	await waitFor(() => {
		const created = stubbed.calls.find(
			(call) => call.path === "/api/sessions" && call.method === "POST",
		);
		expect(created?.body).toEqual({ recipe: "tool-table", label: "what time is it?" });
	});
	const start = stubbed.calls.find((call) => call.path === "/v1/commands");
	expect(start?.body).toMatchObject({ command: "start", session: "s_new", task: "tool-table" });
	// The URL a reload lands on is the same conversation.
	expect(window.location.search).toBe("?session=s_new");
	// The person's own line is on the page, and the sidebar lists the conversation.
	expect(await screen.findByText(/what time is it\?/)).toBeTruthy();
	expect(await screen.findByRole("button", { name: /what time is it\?/ })).toBeTruthy();
});

test("PGS18 a conversation in the URL is rebuilt from its record, including what the person said", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	stubFetch(
		loaded([
			{
				method: "GET",
				path: "/api/sessions",
				answer: () =>
					json({
						sessions: [
							{
								session: "s_1",
								label: "an old question",
								recipe: "tool-table",
								lastUsed: 2,
							},
						],
					}),
			},
			{
				method: "POST",
				path: "/v1/commands",
				answer: (body) =>
					(body as { command?: string }).command === "get_messages"
						? json({
								type: "response",
								ok: true,
								data: {
									entries: [
										{ type: "header" },
										{
											type: "user_message",
											label: "task",
											text: "an old question",
										},
										{
											type: "assistant_message",
											text: "an old answer",
											toolCalls: [],
											usage: {},
										},
										{ type: "status", state: "done" },
									],
									cursor: null,
								},
							})
						: frame(),
			},
			// The stream from the end of the record: nothing left to replay.
			{ method: "GET", path: "/v1/events", answer: () => sse([]) },
		]),
	);
	render(Page);

	// The person's line comes from the record, which is why this reads `get_messages`
	// rather than replaying events: `user_message` is not a protocol event.
	expect(await screen.findByText(/an old question/)).toBeTruthy();
	expect(await screen.findByText(/an old answer/)).toBeTruthy();
	await waitFor(() => expect(document.querySelector(".status")?.textContent).toContain("done"));
	// And the record panel holds the entries the transcript was built from.
	await fireEvent.click(await screen.findByText(/Record/));
	expect(await screen.findByText(/"user_message"/)).toBeTruthy();
});

test("PGS18 a conversation the index does not know still opens", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_2");
	stubFetch(
		loaded([
			{
				method: "POST",
				path: "/v1/commands",
				answer: () =>
					json({ type: "response", ok: true, data: { entries: [], cursor: null } }),
			},
			{ method: "GET", path: "/v1/events", answer: () => sse([]) },
		]),
	);
	render(Page);

	// A run that predates the index is still a session with a record, and refusing to
	// open it would lose work a person can still see.
	expect(await screen.findByLabelText("Ask Lyra")).toBeTruthy();
	expect(screen.queryByRole("alert")).toBeNull();
});

test("PGS21 a running conversation can be steered and stopped", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	const stubbed = stubFetch(
		loaded([
			{
				method: "POST",
				path: "/v1/commands",
				answer: (body) =>
					(body as { command?: string }).command === "get_messages"
						? json({
								type: "response",
								ok: true,
								data: {
									entries: [
										{
											type: "assistant_message",
											text: "thinking about it",
											toolCalls: [],
										},
										{ type: "status", state: "running" },
									],
									cursor: null,
								},
							})
						: frame(),
			},
			{ method: "GET", path: "/v1/events", answer: () => sse([]) },
		]),
	);
	render(Page);

	// The controls only exist while a run is going: a steer with nothing running is a
	// conflict the protocol would answer anyway, and offering it would be a dead button.
	const steer = await screen.findByLabelText("Steer");
	await fireEvent.input(steer, { target: { value: "use the other tool" } });
	await fireEvent.click(screen.getByRole("button", { name: "Steer" }));
	await waitFor(() => {
		expect(
			stubbed.calls.some((call) => (call.body as { command?: string })?.command === "steer"),
		).toBe(true);
	});

	await fireEvent.click(screen.getByRole("button", { name: "Stop" }));
	await waitFor(() => {
		expect(
			stubbed.calls.some((call) => (call.body as { command?: string })?.command === "abort"),
		).toBe(true);
	});
});

test("PGS19 a message in an open conversation is a follow-up, and the URL stays put", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	const stubbed = stubFetch(
		loaded([
			{
				method: "POST",
				path: "/v1/commands",
				answer: (body) =>
					(body as { command?: string }).command === "get_messages"
						? json({ type: "response", ok: true, data: { entries: [], cursor: null } })
						: frame(),
			},
			{
				method: "PUT",
				path: "/api/sessions/s_1",
				answer: () =>
					json({ session: "s_1", label: "x", recipe: "tool-table", lastUsed: 3 }),
			},
			{ method: "GET", path: "/v1/events", answer: () => sse([]) },
		]),
	);
	render(Page);

	// The Send button is what a selected conversation has and a new one does not, so
	// waiting for it is waiting for the record and the stream to have been read.
	const field = await screen.findByLabelText("Ask Lyra");
	await screen.findByRole("button", { name: "Send" });
	await fireEvent.input(field, { target: { value: "and now?" } });
	await fireEvent.click(screen.getByRole("button", { name: "Send" }));

	await waitFor(() => {
		const followUp = stubbed.calls.find(
			(call) => (call.body as { command?: string })?.command === "follow_up",
		);
		expect(followUp?.body).toMatchObject({ session: "s_1", text: "and now?" });
	});
	// Using a conversation moves it up the sidebar, and the URL is the one it already had.
	expect(
		stubbed.calls.some((call) => call.method === "PUT" && call.path === "/api/sessions/s_1"),
	).toBe(true);
	expect(window.location.search).toBe("?session=s_1");
});

test("PGS10 a run streams into the transcript, with the tools it called", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	stubFetch(
		loaded([
			{ method: "POST", path: "/api/sessions", answer: () => json({ session: "s_1" }, 201) },
			{ method: "POST", path: "/v1/commands", answer: () => started() },
			{
				method: "GET",
				path: "/v1/events",
				answer: () =>
					sse([
						{ type: "run_start", run: "r_1" },
						{
							type: "message_end",
							text: "Let me check.",
							reasoning: "the person asked for the time",
							toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
						},
						{
							type: "tool_call",
							ts: 1_000,
							call: { id: "c1", name: "now", arguments: "{}" },
						},
						{
							type: "tool_end",
							ts: 1_240,
							callId: "c1",
							name: "now",
							isError: false,
							content: "2026-11-25T00:00:00.000Z",
						},
						{
							type: "run_end",
							reason: "done",
							turn: 2,
							usage: { inputTokens: 3, outputTokens: 4 },
						},
					]),
			},
		]),
	);
	render(Page);

	const field = await screen.findByLabelText("Ask Lyra");
	await screen.findByRole("option", { name: "tool-table" });
	await fireEvent.input(field, { target: { value: "what time is it?" } });
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// The question, the model's text, the tool's answer and the status line are all on
	// the page, which is the whole of what slice 2 promises a person.
	await screen.findByText(/what time is it\?/);
	await screen.findByText(/Let me check\./);
	await screen.findByText(/2026-11-25T00:00:00\.000Z/);
	await screen.findByText(/thinking/);
	// The call's row is the call and its result: the state and the record's own duration
	// are drawn beside it, which is what slice 4 adds to the page (PGS24, PGS25).
	await screen.findByText("240 ms");
	// The call row says "done" now as well, so the status line is asserted on the
	// element that is the run's, not on any text that happens to match.
	await waitFor(() => expect(document.querySelector(".status")?.textContent).toContain("done"));
});

test("PGS09 a refused token clears the box and asks for it again", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-stale-token");
	stubFetch([
		{
			method: "GET",
			path: "/api/recipes",
			answer: () =>
				json(
					{
						error: {
							code: "permission_denied",
							message: "that token is not one this host knows",
						},
					},
					403,
				),
		},
		{ method: "GET", path: "/api/sessions", answer: () => json({ sessions: [] }) },
	]);
	render(Page);

	// The sidebar's own route is the first thing a page with a token asks, so a refused
	// token is caught before a person can type into a box that will never work.
	await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull());
	expect(await screen.findByLabelText("Token")).toBeTruthy();
	expect(screen.getByRole("alert").textContent).toContain("refused");
});

test("PGS24 a call's badge is drawn from the run's state, while it is still going", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	stubFetch(
		loaded([
			{ method: "POST", path: "/api/sessions", answer: () => json({ session: "s_1" }, 201) },
			{ method: "POST", path: "/v1/commands", answer: () => started() },
			{
				method: "GET",
				path: "/v1/events",
				answer: () =>
					sse([
						{ type: "run_start", run: "r_1" },
						{ type: "message_end", text: "", toolCalls: [] },
						{
							type: "tool_call",
							ts: 1_000,
							call: { id: "c1", name: "now", arguments: "{}" },
						},
						{
							type: "tool_call",
							ts: 1_000,
							call: { id: "c2", name: "calculator", arguments: "{}" },
						},
					]),
			},
		]),
	);
	render(Page);

	await screen.findByRole("option", { name: "tool-table" });
	await fireEvent.input(await screen.findByLabelText("Ask Lyra"), {
		target: { value: "what time is it?" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// Two calls, no results, and the run has not ended: both rows say running, and the
	// page says it is waiting rather than claiming there will be no result.
	await waitFor(() => {
		const states = [...document.querySelectorAll(".tool .call .state")].map(
			(node) => node.textContent,
		);
		expect(states).toEqual(["running", "running"]);
	});
	// Both open calls say it, so the assertion is on the set rather than one element.
	await waitFor(() => expect(document.querySelectorAll(".tool p.state").length).toBe(2));
});

test("PGS24 a call with no result reads unfinished once the run has ended", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	stubFetch(
		loaded([
			{ method: "POST", path: "/api/sessions", answer: () => json({ session: "s_1" }, 201) },
			{ method: "POST", path: "/v1/commands", answer: () => started() },
			{
				method: "GET",
				path: "/v1/events",
				answer: () =>
					sse([
						{ type: "run_start", run: "r_1" },
						{ type: "message_end", text: "", toolCalls: [] },
						{
							type: "tool_call",
							ts: 1_000,
							call: { id: "c1", name: "now", arguments: "{}" },
						},
						{
							type: "tool_call",
							ts: 1_000,
							call: { id: "c2", name: "calculator", arguments: "{}" },
						},
						{
							type: "tool_end",
							ts: 1_030,
							callId: "c1",
							name: "now",
							isError: false,
							content: "ok",
						},
						{
							type: "run_end",
							reason: "parked",
							turn: 1,
							usage: { inputTokens: 1, outputTokens: 1 },
						},
					]),
			},
		]),
	);
	render(Page);

	await screen.findByRole("option", { name: "tool-table" });
	await fireEvent.input(await screen.findByLabelText("Ask Lyra"), {
		target: { value: "what time is it?" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// The answered call is done; the unanswered one is unfinished, not running for ever.
	await waitFor(() => {
		const states = [...document.querySelectorAll(".tool .call .state")].map(
			(node) => node.textContent,
		);
		expect(states).toEqual(["done", "unfinished"]);
	});
	expect(await screen.findByText(/no result: the run moved on or was stopped/)).toBeTruthy();
});

/**
 * The cards (issue #60, slice 6). A parked run is a dead end until a person can answer
 * it, which is what these prove through the page a person actually loads.
 */
function parkedSession(entries: readonly Record<string, unknown>[], pending?: unknown): Route[] {
	return loaded([
		{
			method: "GET",
			path: "/api/sessions",
			answer: () =>
				json({
					sessions: [
						{
							session: "s_1",
							label: "a parked run",
							recipe: "tool-table",
							lastUsed: 1,
						},
					],
				}),
		},
		{
			method: "POST",
			path: "/v1/commands",
			answer: (body) => {
				const command = (body as { command?: string }).command;
				if (command === "get_messages") {
					return json({ type: "response", ok: true, data: { entries, cursor: null } });
				}
				if (command === "list_pending") {
					return json({
						type: "response",
						ok: true,
						data: pending ?? { requests: [], proposals: [] },
					});
				}
				return frame();
			},
		},
		{ method: "POST", path: "/v1/ui_response", answer: () => frame() },
		{ method: "GET", path: "/v1/events", answer: () => sse([]) },
	]);
}

test("PGS33 an approval is approved or denied from the page, with its note", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	const stubbed = stubFetch(
		parkedSession([
			{
				type: "request",
				request: "r1",
				kind: "approve",
				title: "keep a note?",
				message: "notes_write wants to keep a note",
				tool: "notes_write",
				args: "{}",
			},
			{ type: "status", state: "parked", reason: "waiting_for_person" },
		]),
	);
	render(Page);

	// The card is on load, from the record: the run parked while the page was closed and
	// the person can still answer it (REQ02).
	// Wait on the card itself, not on its title: the record panel holds the same text in
	// its JSON, so a text match can resolve before the transcript has been drawn.
	await fireEvent.input(await screen.findByLabelText("Note"), {
		target: { value: "only this one" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Approve" }));

	await waitFor(() => {
		const answer = stubbed.calls.find((call) => call.path === "/v1/ui_response");
		expect(answer?.body).toMatchObject({
			type: "ui_response",
			request: "r1",
			session: "s_1",
			ok: true,
			note: "only this one",
		});
	});
	// The card closes in place rather than staying a live button.
	await waitFor(() => expect(screen.getByText(/^approved/)).toBeTruthy());
});

test("PGS33 a question is answered with text, and a choice with an id", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	const stubbed = stubFetch(
		parkedSession([
			{
				type: "request",
				request: "r1",
				kind: "question",
				title: "which?",
				message: "which note should I read?",
			},
			{
				type: "request",
				request: "r2",
				kind: "choice",
				title: "pick one",
				message: "pick a shelf",
				options: [{ id: "a", label: "the first" }],
			},
		]),
	);
	render(Page);

	await fireEvent.input(await screen.findByLabelText("Answer"), {
		target: { value: "the milk one" },
	});
	await fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
	await waitFor(() => {
		const answer = stubbed.calls.find(
			(call) =>
				call.path === "/v1/ui_response" &&
				(call.body as { request?: string })?.request === "r1",
		);
		expect(answer?.body).toMatchObject({ ok: true, text: "the milk one" });
	});

	await fireEvent.click(await screen.findByRole("button", { name: "the first" }));
	await waitFor(() => {
		const answer = stubbed.calls.find(
			(call) =>
				call.path === "/v1/ui_response" &&
				(call.body as { request?: string })?.request === "r2",
		);
		expect(answer?.body).toMatchObject({ ok: true, ids: ["a"] });
	});
});

test("PGS34 a proposal is accepted from the page", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	const stubbed = stubFetch(
		parkedSession([
			{
				type: "proposal",
				proposal: "p1",
				payload: { summary: "the notes are kept" },
				evidence: ["the record"],
				state: "open",
			},
		]),
	);
	render(Page);

	await fireEvent.input(await screen.findByLabelText("Proposal note"), {
		target: { value: "ship it" },
	});
	await fireEvent.click(await screen.findByRole("button", { name: "Accept" }));
	await waitFor(() => {
		const decided = stubbed.calls.find(
			(call) => (call.body as { command?: string })?.command === "decide_proposal",
		);
		expect(decided?.body).toMatchObject({
			proposal: "p1",
			decision: "accept",
			note: "ship it",
			session: "s_1",
		});
	});
	await waitFor(() => expect(screen.getByText(/^accepted/)).toBeTruthy());
});

test("PGS35 a card the record read missed is asked for and drawn", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	window.history.replaceState(null, "", "/?session=s_1");
	stubFetch(
		parkedSession([], {
			requests: [
				{
					request: "r9",
					kind: "question",
					title: "still here",
					message: "a card from list_pending",
				},
			],
			proposals: [],
		}),
	);
	render(Page);

	// The record held no request (its read may have stopped at a page cap), so only
	// `list_pending` knows the run is waiting — and it is drawn.
	expect(await screen.findByText(/a card from list_pending/)).toBeTruthy();
});

test("PGS40 a run's cost is reported, and the cap is shown", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	const stubbed = stubFetch(
		[
			{
				method: "GET",
				path: "/api/cap",
				answer: () => json({ day: "2026-11-26", usd: 0.1, unpriced: false, cap: 1 }),
			},
			{ method: "POST", path: "/api/sessions", answer: () => json({ session: "s_1" }, 201) },
			{
				method: "POST",
				path: "/v1/commands",
				answer: () =>
					json({ type: "response", ok: true, data: { session: "s_1", run: "r_1" } }),
			},
			{
				method: "POST",
				path: "/api/spend",
				answer: (body: unknown) => json({ day: "2026-11-26", ...(body as object), cap: 1 }),
			},
			{
				method: "GET",
				path: "/v1/events",
				answer: () =>
					sse([
						{ type: "run_start", run: "r_1" },
						{
							type: "run_end",
							run: "r_1",
							reason: "done",
							turn: 1,
							usage: { inputTokens: 1, outputTokens: 1, cost: { amount: 0.002 } },
						},
					]),
			},
		].concat(loaded()),
	);
	render(Page);

	// The cap is a line on the page before anything runs, so a person knows the budget.
	expect(await screen.findByText(/spend \$0\.1000 of \$1\.00 today \(UTC\)/)).toBeTruthy();

	await screen.findByRole("option", { name: "tool-table" });
	await fireEvent.input(await screen.findByLabelText("Ask Lyra"), { target: { value: "hi" } });
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// The run's own cost is reported once, from the `run_end` the page saw.
	await waitFor(() => {
		const spent = stubbed.calls.find((call) => call.path === "/api/spend");
		expect(spent?.body).toEqual({ amount: 0.002 });
	});
});
