import { describe, expect, test } from "vitest";

import {
	createFinishTool,
	executionCounter,
	fakeClock,
	fakeModelServer,
	toolReturning,
	type FakeClock,
	type FakeModelFault,
	type FakeModelServer,
	type ScriptedTurn,
} from "../../testkit/index.js";
import type { ModelRequest, ModelSlot } from "../../core/model.js";
import { runTask } from "../../core/run.js";
import { memoryStorage } from "../../adapters/memory/storage.js";
import { loadRecord } from "../../record/load.js";
import type { RunEvent } from "../../core/events.js";
import { counterIds } from "../memory/ids.js";
import { createOpenAIChatModel } from "./model.js";

/**
 * The slot and its errors (docs/adapters.md, OAI20 to OAI29). Every case here
 * goes through the real parser, the real request builder and the fake server's
 * real bytes, so what is asserted is what a host would see.
 */

const KEY_NAME = "MODEL_KEY";
const KEY = "not-a-real-key-for-a-test";

interface Setup {
	clock: FakeClock;
	server: FakeModelServer;
	model: ModelSlot;
}

function setup(
	turns: readonly ScriptedTurn[],
	options: {
		faults?: (FakeModelFault | undefined)[];
		deadlineMs?: number;
		maxBytes?: number;
	} = {},
): Setup {
	const clock = fakeClock();
	const server = fakeModelServer(
		turns,
		options.faults === undefined ? {} : { faults: options.faults },
	);
	const model = createOpenAIChatModel({
		baseUrl: "https://example.test/v1/",
		model: "test/model",
		secrets: {
			get: async (name: string) => (name === KEY_NAME ? KEY : undefined),
		},
		keyName: KEY_NAME,
		headers: { "x-opencode-session": "session-1" },
		fetch: server,
		clock,
		...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
		...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
	});
	return { clock, server, model };
}

function ask(overrides: Partial<ModelRequest> = {}): ModelRequest {
	return {
		system: "you are careful",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
		...overrides,
	};
}

/** Let a call that waits for the fake clock finish, by moving time rather than waiting. */
async function whileAdvancing<T>(clock: FakeClock, pending: Promise<T>, ms = 1_000): Promise<T> {
	let settled = false;
	void pending.then(
		() => {
			settled = true;
		},
		() => {
			settled = true;
		},
	);
	for (let tick = 0; tick < 50 && !settled; tick += 1) {
		await Promise.resolve();
		clock.advance(ms);
		await Promise.resolve();
	}
	return pending;
}

function errorOf(result: Awaited<ReturnType<ModelSlot["complete"]>>): {
	code: string;
	message: string;
	retryable: boolean;
	retryAfterMs?: number;
} {
	if (result.ok) {
		throw new Error("expected an error, got a reply");
	}
	return result.error;
}

test("OAI26 a whole reply comes back through the slot", async () => {
	const { server, model } = setup([
		{
			text: "the file says hello",
			reasoning: "the person asked for it",
			usage: {
				inputTokens: 12,
				outputTokens: 5,
				cost: { amount: 0.0004, currency: "USD", source: "provider" },
			},
		},
	]);

	const result = await model.complete(ask());
	expect(result.ok).toBe(true);
	if (!result.ok) {
		return;
	}
	expect(result.value.text).toBe("the file says hello");
	expect(result.value.reasoning).toBe("the person asked for it");
	expect(result.value.usage).toEqual({
		inputTokens: 12,
		outputTokens: 5,
		cost: { amount: 0.0004, currency: "USD", source: "provider" },
	});
	expect(result.value.finishReason).toBe("stop");

	const [sent] = server.requests;
	expect(sent?.url).toBe("https://example.test/v1/chat/completions");
	expect(sent?.method).toBe("POST");
	expect(sent?.headers["authorization"]).toBe(`Bearer ${KEY}`);
	expect(sent?.headers["x-opencode-session"]).toBe("session-1");
	expect(sent?.headers["content-type"]).toBe("application/json");
	expect(sent?.body).toEqual({
		model: "test/model",
		stream: true,
		messages: [
			{ role: "system", content: "you are careful" },
			{ role: "user", content: "hello" },
		],
	});
	expect(JSON.stringify(sent?.body)).not.toContain(KEY);
});

test("OAI26 a missing secret is refused by name, without the value", async () => {
	const model = createOpenAIChatModel({
		baseUrl: "https://example.test/v1",
		model: "test/model",
		secrets: { get: async () => undefined },
		keyName: "ABSENT_KEY",
		clock: fakeClock(),
	});
	const error = errorOf(await model.complete(ask()));
	expect(error.code).toBe("permission_denied");
	expect(error.retryable).toBe(false);
	expect(error.message).toContain("ABSENT_KEY");
});

test("OAI20 each HTTP status maps to its own error", async () => {
	const expected: [number, string, boolean][] = [
		[400, "bad_request", false],
		[401, "permission_denied", false],
		[403, "permission_denied", false],
		[404, "not_found", false],
		[408, "timeout", true],
		[429, "busy", true],
		[500, "provider_error", true],
		[502, "provider_error", true],
		[503, "provider_error", true],
		[504, "provider_error", true],
		[418, "provider_error", false],
	];
	for (const [status, code, retryable] of expected) {
		const { model } = setup([{ text: "unused" }], { faults: [{ kind: "status", status }] });
		const error = errorOf(await model.complete(ask()));
		expect([status, error.code, error.retryable]).toEqual([status, code, retryable]);
		expect(error.message).toContain(String(status));
	}
});

describe("OAI21 Retry-After", () => {
	test("OAI21 in seconds", async () => {
		const { model } = setup([{ text: "x" }], {
			faults: [{ kind: "status", status: 429, retryAfter: "2" }],
		});
		expect(errorOf(await model.complete(ask())).retryAfterMs).toBe(2_000);
	});

	test("OAI21 as an HTTP date", async () => {
		const clock = fakeClock();
		const at = new Date(clock.now() + 5_000).toUTCString();
		const server = fakeModelServer([{ text: "x" }], {
			faults: [{ kind: "status", status: 429, retryAfter: at }],
		});
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: server,
			clock,
		});
		expect(errorOf(await model.complete(ask())).retryAfterMs).toBe(5_000);
	});

	test("OAI21 a date already past is no wait at all", async () => {
		const clock = fakeClock();
		const at = new Date(clock.now() - 5_000).toUTCString();
		const server = fakeModelServer([{ text: "x" }], {
			faults: [{ kind: "status", status: 503, retryAfter: at }],
		});
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: server,
			clock,
		});
		expect(errorOf(await model.complete(ask())).retryAfterMs).toBe(0);
	});

	test("OAI21 an absurd value is capped", async () => {
		const { model } = setup([{ text: "x" }], {
			faults: [{ kind: "status", status: 503, retryAfter: "999999" }],
		});
		expect(errorOf(await model.complete(ask())).retryAfterMs).toBe(300_000);
	});

	test("OAI21 a missing header means no wait", async () => {
		const { model } = setup([{ text: "x" }], { faults: [{ kind: "status", status: 429 }] });
		expect(errorOf(await model.complete(ask())).retryAfterMs).toBeUndefined();
	});
});

describe("OAI22 an answer that is an error", () => {
	test("OAI22 a 200 whose body is an error object", async () => {
		const { model } = setup([{ text: "x" }], {
			faults: [{ kind: "error-body", message: "the model is overloaded" }],
		});
		const error = errorOf(await model.complete(ask()));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("the model is overloaded");
	});

	test("OAI22 a non-JSON error body is truncated and echoes no header", async () => {
		const { model } = setup([{ text: "x" }], { faults: [{ kind: "non-json" }] });
		const error = errorOf(await model.complete(ask()));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("bad gateway");
		expect(error.message).not.toContain(KEY);
		expect(error.message.toLowerCase()).not.toContain("authorization");
	});

	test("OAI22 a long error body is cut down to a message", async () => {
		const { model } = setup([{ text: "x" }], {
			faults: [{ kind: "status", status: 500, body: "y".repeat(5_000) }],
		});
		const error = errorOf(await model.complete(ask()));
		expect(error.message.length).toBeLessThan(400);
	});

	test("OAI22 an error chunk mid-stream is kept as the provider's message", async () => {
		const { model } = setup([{ text: "x" }], {
			faults: [{ kind: "mid-stream-error", status: 429, message: "slow down" }],
		});
		const error = errorOf(await model.complete(ask()));
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("slow down");
	});
});

describe("OAI23 the network", () => {
	test("OAI23 a fetch that rejects is retryable", async () => {
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: async () => {
				throw new TypeError("fetch failed");
			},
			clock: fakeClock(),
		});
		const error = errorOf(await model.complete(ask()));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("fetch failed");
		expect(error.message).not.toContain(KEY);
	});

	test("OAI23 a body that fails mid-stream is retryable", async () => {
		const { model } = setup([{ text: "x" }], { faults: [{ kind: "body-error" }] });
		const error = errorOf(await model.complete(ask()));
		expect(error.code).toBe("provider_error");
		expect(error.retryable).toBe(true);
		expect(error.message).toContain("connection was reset");
	});
});

test("OAI24 a stall is abandoned at the deadline as a retryable timeout", async () => {
	const { clock, model } = setup([{ text: "x" }], {
		faults: [{ kind: "stall" }],
		deadlineMs: 2_000,
	});
	const pending = model.complete(ask());
	const result = await whileAdvancing(clock, pending);
	const error = errorOf(result);
	expect(error.code).toBe("timeout");
	expect(error.retryable).toBe(true);
	expect(error.message).toContain("2000");
});

describe("OAI25 a stop", () => {
	test("OAI25 before the request nothing is sent", async () => {
		const { server, model } = setup([{ text: "x" }]);
		const controller = new AbortController();
		controller.abort();
		const error = errorOf(await model.complete(ask({ signal: controller.signal })));
		expect(error.retryable).toBe(false);
		expect(server.requests).toHaveLength(0);
	});

	test("OAI25 a stop during the secrets lookup sends nothing", async () => {
		const controller = new AbortController();
		const server = fakeModelServer([{ text: "x" }]);
		let release = (): void => undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: {
				get: async () => {
					await gate;
					return KEY;
				},
			},
			keyName: KEY_NAME,
			fetch: server,
			clock: fakeClock(),
		});
		const pending = model.complete(ask({ signal: controller.signal }));
		controller.abort();
		release();
		const error = errorOf(await pending);
		expect(error.retryable).toBe(false);
		// The point of the row: a stop before the request costs nothing.
		expect(server.requests).toHaveLength(0);
	});

	test("OAI25 during connect the call ends", async () => {
		const { server, model } = setup([{ text: "x" }], { faults: [{ kind: "stall" }] });
		const controller = new AbortController();
		const pending = model.complete(ask({ signal: controller.signal }));
		await Promise.resolve();
		controller.abort();
		const error = errorOf(await pending);
		expect(error.retryable).toBe(false);
		expect(server.requests).toHaveLength(1);
	});

	test("OAI25 mid-stream the call ends and the stream is closed", async () => {
		let closed = false;
		const encoder = new TextEncoder();
		const { model } = setup([{ text: "x" }], {
			faults: [
				{
					kind: "custom",
					answer: () =>
						new Response(
							new ReadableStream<Uint8Array>({
								start(controller) {
									controller.enqueue(
										encoder.encode(
											'data: {"choices":[{"index":0,"delta":{"content":"hal',
										),
									);
								},
								cancel() {
									closed = true;
								},
							}),
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						),
				},
			],
		});
		const controller = new AbortController();
		const pending = model.complete(ask({ signal: controller.signal }));
		await Promise.resolve();
		await Promise.resolve();
		controller.abort();
		const error = errorOf(await pending);
		expect(error.retryable).toBe(false);
		expect(closed).toBe(true);
	});

	test("OAI25 after the last chunk the reply is still not handed over", async () => {
		const encoder = new TextEncoder();
		const controller = new AbortController();
		const { model } = setup([{ text: "x" }], {
			faults: [
				{
					kind: "custom",
					answer: () => {
						const body =
							'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n' +
							"data: [DONE]\n\n";
						return new Response(
							new ReadableStream<Uint8Array>({
								start(stream) {
									stream.enqueue(encoder.encode(body));
									stream.close();
									// The person stops just as the last chunk arrives.
									controller.abort();
								},
							}),
							{ status: 200, headers: { "content-type": "text/event-stream" } },
						);
					},
				},
			],
		});
		const result = await model.complete(ask({ signal: controller.signal }));
		expect(result.ok).toBe(false);
		expect(errorOf(result).retryable).toBe(false);
	});
});

describe("through a whole run", () => {
	test("OAI27 a 429 and then a good stream completes the run", async () => {
		const clock = fakeClock();
		const storage = memoryStorage();
		const events: RunEvent[] = [];
		const server = fakeModelServer([{ toolCalls: [{ id: "c1", name: "finish", args: {} }] }], {
			faults: [{ kind: "status", status: 429, retryAfter: "1" }],
		});
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: server,
			clock,
		});

		const pending = runTask({
			runId: "run-1",
			task: "test-task",
			host: "test-host",
			input: "do the thing",
			system: "you are a test",
			tools: [createFinishTool()],
			model,
			storage,
			clock,
			ids: counterIds(),
			onEvent: (event) => {
				events.push(event);
			},
		});
		const result = await whileAdvancing(clock, pending, 1_000);

		expect(result.reason).toBe("done");
		expect(events.filter((event) => event.type === "retry")).toHaveLength(1);
		expect(server.requests).toHaveLength(2);

		const saved = await storage.read();
		expect(saved.ok).toBe(true);
		if (!saved.ok) {
			return;
		}
		const record = loadRecord(saved.value);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		const assistant = record.value.entries.find((entry) => entry.type === "assistant_message");
		expect(assistant).toEqual(expect.objectContaining({ retries: 1 }));
	});

	test("OAI28 four 500s park the run as model_unavailable", async () => {
		const clock = fakeClock();
		const storage = memoryStorage();
		const server = fakeModelServer([{ text: "never used" }], {
			faults: [
				{ kind: "status", status: 500 },
				{ kind: "status", status: 500 },
				{ kind: "status", status: 500 },
				{ kind: "status", status: 500 },
			],
		});
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: server,
			clock,
		});

		const result = await whileAdvancing(
			clock,
			runTask({
				runId: "run-2",
				task: "test-task",
				host: "test-host",
				input: "do the thing",
				system: "you are a test",
				tools: [createFinishTool()],
				model,
				storage,
				clock,
				ids: counterIds(),
			}),
			16_000,
		);
		expect(result.reason).toBe("parked");
		expect(result.parkedReason).toBe("model_unavailable");
		expect(server.requests).toHaveLength(4);
	});

	test("OAI29 a reply cut off on the token limit never runs its call", async () => {
		const clock = fakeClock();
		const storage = memoryStorage();
		const counter = executionCounter();
		const readTool = toolReturning("read", "the file", { executions: counter });
		const server = fakeModelServer(
			[
				{
					toolCalls: [{ id: "c1", name: "read", args: { path: "/a.txt" } }],
					finishReason: "length",
				},
				{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
			],
			{},
		);
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: server,
			clock,
		});

		const result = await runTask({
			runId: "run-3",
			task: "test-task",
			host: "test-host",
			input: "do the thing",
			system: "you are a test",
			tools: [readTool, createFinishTool()],
			model,
			storage,
			clock,
			ids: counterIds(),
		});

		expect(result.reason).toBe("done");
		expect(counter.ids()).toEqual([]);
		const saved = await storage.read();
		expect(saved.ok).toBe(true);
		if (!saved.ok) {
			return;
		}
		const record = loadRecord(saved.value);
		expect(record.ok).toBe(true);
		if (!record.ok) {
			return;
		}
		const toolMessage = record.value.entries.find(
			(entry) => entry.type === "tool_message" && entry.toolCallId === "c1",
		);
		expect(toolMessage).toEqual(
			expect.objectContaining({ isError: true, content: expect.stringContaining("not run") }),
		);
	});
});

describe("OAI22 a key the provider echoes is redacted before the message is cut", () => {
	// Redacting after the cut leaves any key that straddles the cut as a prefix,
	// which is most of the key and is not found by an exact match.
	const echoed = (padding: number): string => `${"a".repeat(padding)}${KEY}${"b".repeat(100)}`;

	async function failWith(response: () => Response): Promise<string> {
		const model = createOpenAIChatModel({
			baseUrl: "https://example.test/v1",
			model: "test/model",
			secrets: { get: async () => KEY },
			keyName: KEY_NAME,
			fetch: async () => response(),
			clock: fakeClock(),
		});
		return errorOf(await model.complete(ask())).message;
	}

	// Every offset puts the key at a different place against the 300-character cut,
	// including across it, so the check does not depend on one lucky alignment.
	const offsets = [200, 235, 250, 255, 262, 267, 270, 280, 290, 300];

	test.each(offsets)("OAI22 a failing status with the key at %i", async (offset) => {
		const message = await failWith(
			() =>
				new Response(echoed(offset), {
					status: 500,
					headers: { "content-type": "text/plain" },
				}),
		);
		expect(message).toContain("500");
		expect(message).not.toContain(KEY.slice(0, 8));
	});

	test.each(offsets)("OAI22 an error chunk mid-stream with the key at %i", async (offset) => {
		const chunk = JSON.stringify({ error: { code: 500, message: echoed(offset) } });
		const message = await failWith(
			() =>
				new Response(`data: ${chunk}\n\n`, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		expect(message.length).toBeGreaterThan(0);
		expect(message).not.toContain(KEY.slice(0, 8));
	});

	test.each(offsets)("OAI22 a 200 that is not a stream with the key at %i", async (offset) => {
		const message = await failWith(
			() =>
				new Response(echoed(offset), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		expect(message).toContain("without a stream");
		expect(message).not.toContain(KEY.slice(0, 8));
	});
});
