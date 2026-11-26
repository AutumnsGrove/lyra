import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import Page from "./+page.svelte";

/**
 * The rows are in `docs/playground.md`: PGS08 to PGS10, seen through the page a person
 * loads.
 *
 * These render the real component into `happy-dom` — a Node document, not a browser — so
 * what they prove is the wiring the library tests cannot: that the token box is what a
 * person without a token sees, that a run's events reach the transcript, and that a
 * refused token sends them back to the box.
 */

const TOKEN_KEY = "lyra-playground-token";

/** The frames a stubbed `fetch` answers, in order, keyed by the path it is asked for. */
function stubFetch(options: { start: () => Response; events?: () => Response }): void {
	vi.stubGlobal("fetch", async (url: string) => {
		if (String(url).includes("/v1/events")) {
			return options.events?.() ?? new Response("", { status: 200 });
		}
		return options.start();
	});
}

function sse(events: readonly Record<string, unknown>[]): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const event of events) {
				controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
			}
			controller.close();
		},
	});
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function started(session = "s_1", run = "r_1"): Response {
	return new Response(JSON.stringify({ type: "response", ok: true, data: { session, run } }), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	window.localStorage.clear();
});

afterEach(() => {
	// The library only unmounts automatically when its own globals are on, and this
	// config keeps vitest's globals off. Without this the second test finds two pages.
	cleanup();
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
	render(Page);

	const field = await screen.findByLabelText("Token");
	await fireEvent.input(field, { target: { value: "  a-token-for-a-test  " } });
	await fireEvent.click(screen.getByRole("button", { name: "Open" }));

	// Trimmed on the way in, and kept where the next load will find it.
	await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBe("a-token-for-a-test"));
	expect(await screen.findByLabelText("Ask Lyra")).toBeTruthy();
});

test("PGS10 a run streams into the transcript, with the tools it called", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-token-for-a-test");
	stubFetch({
		start: () => started(),
		events: () =>
			sse([
				{ type: "run_start", run: "r_1" },
				{
					type: "message_end",
					text: "Let me check.",
					reasoning: "the person asked for the time",
					toolCalls: [{ id: "c1", name: "now", arguments: "{}" }],
				},
				{ type: "tool_call", call: { id: "c1", name: "now", arguments: "{}" } },
				{
					type: "tool_end",
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
	});
	render(Page);

	const field = await screen.findByLabelText("Ask Lyra");
	await fireEvent.input(field, { target: { value: "what time is it?" } });
	await fireEvent.click(screen.getByRole("button", { name: "Run" }));

	// The question, the model's text, the tool's answer and the status line are all on
	// the page, which is the whole of what slice 2 promises a person.
	await screen.findByText(/what time is it\?/);
	await screen.findByText(/Let me check\./);
	await screen.findByText(/2026-11-25T00:00:00\.000Z/);
	await screen.findByText(/thinking/);
	await screen.findByText(/done/);
});

test("PGS09 a refused token clears the box and asks for it again", async () => {
	window.localStorage.setItem(TOKEN_KEY, "a-stale-token");
	stubFetch({
		start: () =>
			new Response(
				JSON.stringify({
					type: "response",
					ok: false,
					error: {
						code: "permission_denied",
						message: "that token is not one this host knows",
					},
				}),
				{ status: 403, headers: { "content-type": "application/json" } },
			),
	});
	render(Page);

	await fireEvent.click(await screen.findByRole("button", { name: "Run" }));

	// The 403 is what makes the page forget: a refused token that stayed in storage would
	// be a person typing a new one and being refused for the old one.
	await waitFor(() => expect(window.localStorage.getItem(TOKEN_KEY)).toBeNull());
	expect(await screen.findByLabelText("Token")).toBeTruthy();
	expect(screen.getByRole("alert").textContent).toContain("refused");
});
