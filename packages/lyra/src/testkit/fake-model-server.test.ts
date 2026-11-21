import { expect, test } from "vitest";

import { sseReader } from "../adapters/openai/sse.js";
import { fakeModelServer } from "./fake-model-server.js";

/**
 * The fake server itself (docs/engineering-practices.md, KIT09 to KIT11). It is
 * what every adapter test stands on, so it gets the same strict treatment as the
 * code it serves: the bytes it writes go through the real parser, and each
 * misbehavior is checked to be the one named.
 */

const post = (body: unknown): Parameters<ReturnType<typeof fakeModelServer>>[1] => ({
	method: "POST",
	headers: { authorization: "Bearer not-a-real-key" },
	body: JSON.stringify(body),
});

/** Read a whole stream back as the parser would, and say how it ended. */
async function assemble(response: Response): Promise<unknown> {
	const reader = sseReader();
	const stream = response.body?.getReader();
	if (stream === undefined || stream === null) {
		throw new Error("the server sent no body");
	}
	const decoder = new TextDecoder();
	for (;;) {
		const read = await stream.read();
		if (read.done) {
			break;
		}
		const pushed = reader.push(decoder.decode(read.value, { stream: true }));
		if (!pushed.ok) {
			return pushed.error;
		}
		if (pushed.value !== undefined) {
			return pushed.value;
		}
	}
	const ended = reader.end();
	return ended.ok ? ended.value : ended.error;
}

test("KIT09 a script is served as the stream a provider would send", async () => {
	const server = fakeModelServer(
		[
			{
				text: "the file says hello",
				reasoning: "the person asked for it",
				toolCalls: [{ id: "call_1", name: "read", args: { path: "/a.txt" } }],
				usage: {
					inputTokens: 9,
					outputTokens: 4,
					cost: { amount: 0.02, currency: "USD", source: "provider" },
				},
				finishReason: "tool_calls",
			},
		],
		{ model: "fake/model" },
	);

	const response = await server(
		"https://example.test/v1/chat/completions",
		post({ messages: [] }),
	);
	expect(response.ok).toBe(true);
	const reply = (await assemble(response)) as {
		text: string;
		reasoning?: string;
		toolCalls: { id: string; name: string; arguments: string }[];
		usage: { inputTokens: number; outputTokens: number; cost?: { amount: number } };
		finishReason: string;
		model: string;
	};
	expect(reply.text).toBe("the file says hello");
	expect(reply.reasoning).toBe("the person asked for it");
	expect(reply.toolCalls).toEqual([
		{ id: "call_1", name: "read", arguments: '{"path":"/a.txt"}' },
	]);
	expect(reply.usage.inputTokens).toBe(9);
	expect(reply.usage.cost?.amount).toBe(0.02);
	expect(reply.finishReason).toBe("tool_calls");
	expect(reply.model).toBe("fake/model");
});

test("KIT09 the turn is chosen by the assistant messages already in the request", async () => {
	const server = fakeModelServer([{ text: "first" }, { text: "second" }]);
	const first = await assemble(await server("https://example.test", post({ messages: [] })));
	const second = await assemble(
		await server(
			"https://example.test",
			post({ messages: [{ role: "assistant" }, { role: "tool" }, { role: "user" }] }),
		),
	);
	expect((first as { text: string }).text).toBe("first");
	expect((second as { text: string }).text).toBe("second");
});

test("KIT09 a script with no turn left answers a clear failure", async () => {
	const server = fakeModelServer([{ text: "only" }]);
	await server("https://example.test", post({ messages: [{ role: "assistant" }] }));
	const response = await server(
		"https://example.test",
		post({ messages: [{ role: "assistant" }, { role: "assistant" }] }),
	);
	expect(response.ok).toBe(false);
	expect(await response.text()).toContain("no turn 3");
});

test("KIT10 each misbehavior is the one it says it is", async () => {
	const cases = [
		{ kind: "cut" as const, check: (response: Response) => expect(response.ok).toBe(true) },
		{ kind: "malformed" as const, check: () => {} },
		{
			kind: "status" as const,
			status: 429,
			retryAfter: "7",
			check: (response: Response) => {
				expect(response.status).toBe(429);
				expect(response.headers.get("retry-after")).toBe("7");
			},
		},
		{
			kind: "status" as const,
			status: 500,
			check: (response: Response) => expect(response.status).toBe(500),
		},
		{
			kind: "non-json" as const,
			check: async (response: Response) => {
				expect(response.status).toBe(500);
				expect(await response.text()).toContain("bad gateway");
			},
		},
		{
			kind: "error-body" as const,
			check: async (response: Response) => {
				expect(response.status).toBe(200);
				expect(await response.text()).toContain("could not be reached");
			},
		},
	];
	for (const [index, one] of cases.entries()) {
		const server = fakeModelServer([{ text: "unused" }], { faults: [{ ...one }] });
		const response = await server("https://example.test", post({ messages: [] }));
		await one.check(response);
		expect(index).toBeGreaterThanOrEqual(0);
	}
});

test("KIT10 a stream that is cut and one that is malformed read as errors", async () => {
	const cut = fakeModelServer([{ text: "x" }], { faults: [{ kind: "cut" }] });
	const cutReply = await assemble(await cut("https://example.test", post({ messages: [] })));
	expect(cutReply).toEqual(
		expect.objectContaining({
			code: "provider_error",
			message: expect.stringContaining("ended"),
		}),
	);

	const malformed = fakeModelServer([{ text: "x" }], { faults: [{ kind: "malformed" }] });
	const malformedReply = await assemble(
		await malformed("https://example.test", post({ messages: [] })),
	);
	expect(malformedReply).toEqual(
		expect.objectContaining({
			code: "provider_error",
			message: expect.stringContaining("JSON"),
		}),
	);

	const midStream = fakeModelServer([{ text: "x" }], {
		faults: [{ kind: "mid-stream-error", status: 429, message: "slow down" }],
	});
	const midStreamReply = await assemble(
		await midStream("https://example.test", post({ messages: [] })),
	);
	expect(midStreamReply).toEqual(
		expect.objectContaining({ code: "provider_error", retryable: true }),
	);
	expect((midStreamReply as { message: string }).message).toContain("slow down");
});

test("KIT10 a huge chunk is served as one enormous chunk", async () => {
	const server = fakeModelServer([{ text: "x" }], { faults: [{ kind: "huge", bytes: 5000 }] });
	const response = await server("https://example.test", post({ messages: [] }));
	const reader = sseReader({ maxBytes: 1000 });
	const stream = response.body?.getReader();
	const read = await stream?.read();
	expect(read?.done).toBe(false);
	const pushed = reader.push(new TextDecoder().decode(read?.value));
	expect(pushed.ok).toBe(false);
});

test("KIT10 a body that fails mid-stream is a body that fails mid-stream", async () => {
	const server = fakeModelServer([{ text: "x" }], { faults: [{ kind: "body-error" }] });
	const response = await server("https://example.test", post({ messages: [] }));
	const stream = response.body?.getReader();
	await expect(stream?.read()).rejects.toThrow("the connection was reset");
});

test("KIT10 a stall is only answered by an abort", async () => {
	const server = fakeModelServer([{ text: "x" }], { faults: [{ kind: "stall" }] });
	const controller = new AbortController();
	const pending = server("https://example.test", {
		method: "POST",
		body: "{}",
		signal: controller.signal,
	});
	controller.abort();
	await expect(pending).rejects.toThrow("aborted");
});

test("KIT11 every request is kept, and the key is only in its header", async () => {
	const key = "not-a-real-key-for-a-test";
	const server = fakeModelServer([{ text: "hi" }]);
	await server("https://example.test/v1/chat/completions", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: "m",
			stream: true,
			messages: [{ role: "user", content: "hi" }],
		}),
	});

	expect(server.requests).toHaveLength(1);
	const [seen] = server.requests;
	expect(seen?.url).toBe("https://example.test/v1/chat/completions");
	expect(seen?.method).toBe("POST");
	expect(seen?.headers["authorization"]).toBe(`Bearer ${key}`);
	expect(seen?.body).toEqual({
		model: "m",
		stream: true,
		messages: [{ role: "user", content: "hi" }],
	});
	// The key is in the header a test deliberately put there, and nowhere else.
	expect(JSON.stringify(seen?.body)).not.toContain(key);
});
