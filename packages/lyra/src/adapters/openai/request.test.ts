import { describe, expect, test } from "vitest";

import type { ConversationMessage } from "../../core/conversation.js";
import type { ModelRequest, ToolSpec } from "../../core/model.js";
import { buildHeaders, buildWireRequest, type WireBody } from "./request.js";

/**
 * The wire shape, tested as data (docs/adapters.md, OAI14 to OAI19). The fake
 * server in the testkit checks the round trip end to end; this file checks that
 * what goes out is what the endpoint takes, and nothing else.
 */

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
	return {
		system: "you are careful",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
		...overrides,
	};
}

function body(overrides: Partial<ModelRequest> = {}): WireBody {
	return buildWireRequest({ request: request(overrides), model: "test/model" });
}

const readTool: ToolSpec = {
	name: "read",
	description: "read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	},
};

test("OAI14 every message kind maps to its wire shape", () => {
	const messages: ConversationMessage[] = [
		{ role: "user", text: "hello" },
		{
			role: "assistant",
			text: "reading it",
			reasoning: "the person asked for the file",
			toolCalls: [{ id: "c1", name: "read", arguments: '{"path":"/a.txt"}' }],
		},
		{ role: "tool", toolCallId: "c1", content: "the file", isError: false },
		{ role: "assistant", text: "it says hello", toolCalls: [] },
	];
	const built = body({ messages });
	expect(built.messages).toEqual([
		{ role: "system", content: "you are careful" },
		{ role: "user", content: "hello" },
		{
			role: "assistant",
			content: "reading it",
			tool_calls: [
				{
					id: "c1",
					type: "function",
					function: { name: "read", arguments: '{"path":"/a.txt"}' },
				},
			],
		},
		// The error flag is the loop's business: chat completions has no field for it,
		// and the loop already put what went wrong in the content.
		{ role: "tool", tool_call_id: "c1", content: "the file" },
		{ role: "assistant", content: "it says hello" },
	]);
	expect(built.model).toBe("test/model");
	expect(built.stream).toBe(true);
});

test("OAI14 an empty system prompt is not sent", () => {
	expect(body({ system: "" })["messages"]).toEqual([{ role: "user", content: "hello" }]);
});

test("OAI15 a tool turn round trips through the ids", () => {
	const built = body({
		messages: [
			{ role: "user", text: "go" },
			{
				role: "assistant",
				text: "",
				toolCalls: [
					{ id: "call_a", name: "read", arguments: "{}" },
					{ id: "call_b", name: "read", arguments: "{}" },
				],
			},
			{ role: "tool", toolCallId: "call_b", content: "second", isError: false },
			{ role: "tool", toolCallId: "call_a", content: "first", isError: true },
		],
	});
	const sent = built.messages as {
		role: string;
		tool_calls?: { id: string }[];
		tool_call_id?: string;
	}[];
	const assistant = sent.find((message) => message.role === "assistant");
	const results = sent.filter((message) => message.role === "tool");
	expect(assistant?.tool_calls?.map((call) => call.id)).toEqual(["call_a", "call_b"]);
	expect(results.map((result) => result.tool_call_id)).toEqual(["call_b", "call_a"]);
	for (const result of results) {
		expect(assistant?.tool_calls?.some((call) => call.id === result.tool_call_id)).toBe(true);
	}
});

test("OAI16 nothing a model might reject is sent", () => {
	const built = body({ tools: [readTool] });
	expect(Object.keys(built).sort()).toEqual(["messages", "model", "stream", "tools"]);
	const wire = JSON.stringify(built);
	for (const option of ["tool_choice", "stream_options", "include_usage", "provider", "usage"]) {
		expect(wire).not.toContain(option);
	}
});

test("OAI17 tools map to functions, and the request's model wins", () => {
	const built = body({ tools: [readTool], model: "fallback/model" });
	expect(built.tools).toEqual([
		{
			type: "function",
			function: { name: "read", description: "read a file", parameters: readTool.parameters },
		},
	]);
	expect(built.model).toBe("fallback/model");

	const empty = body({
		tools: [{ name: "finish", description: "", parameters: {} }],
	});
	expect(
		(empty.tools as { function: { parameters: unknown } }[])[0]?.function.parameters,
	).toEqual({});
});

test("OAI18 nothing to send still builds a body the endpoint accepts", () => {
	const built = body({ system: "", messages: [], tools: [] });
	expect(built).toEqual({ model: "test/model", stream: true, messages: [] });
});

describe("OAI19 the key lives in one header", () => {
	const key = "not-a-real-key-for-a-test";

	test("OAI19 the authorization header carries the key and the body does not", () => {
		const built = body({});
		const headers = buildHeaders({
			apiKey: key,
			session: "run-1",
			extra: { "x-title": "Lyra" },
		});
		expect(headers["authorization"]).toBe(`Bearer ${key}`);
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["x-opencode-session"]).toBe("run-1");
		expect(headers["x-title"]).toBe("Lyra");
		expect(JSON.stringify(built)).not.toContain(key);
	});

	test("OAI19 a session header appears only when there is a session", () => {
		const headers = buildHeaders({ apiKey: key });
		expect(headers["x-opencode-session"]).toBeUndefined();
		expect(Object.keys(headers).sort()).toEqual(["accept", "authorization", "content-type"]);
	});

	test("OAI19 a header name is case-insensitive, so a capitalised one cannot either", () => {
		const headers = buildHeaders({
			apiKey: key,
			extra: {
				Authorization: "Bearer someone-else",
				"Content-Type": "text/plain",
				Accept: "application/json",
				"X-Title": "Lyra",
			},
		});
		expect(headers["authorization"]).toBe(`Bearer ${key}`);
		expect(headers["content-type"]).toBe("application/json");
		expect(headers["accept"]).toBe("text/event-stream");
		expect(headers["x-title"]).toBe("Lyra");
		// One name, one value: a differently-cased duplicate would be merged by the
		// runtime and send two credentials.
		expect(Object.keys(headers).every((name) => name === name.toLowerCase())).toBe(true);
	});

	test("OAI19 a preset's own header cannot replace the key", () => {
		const headers = buildHeaders({
			apiKey: key,
			extra: { authorization: "Bearer someone-else", "content-type": "text/plain" },
		});
		expect(headers["authorization"]).toBe(`Bearer ${key}`);
		expect(headers["content-type"]).toBe("application/json");
	});
});
