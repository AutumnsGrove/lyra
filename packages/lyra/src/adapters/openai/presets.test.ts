import { expect, test } from "vitest";

import { fakeClock, fakeModelServer } from "../../testkit/index.js";
import { openCodeGo, openRouter, OPENCODE_GO_BASE_URL, OPENROUTER_BASE_URL } from "./presets.js";

/**
 * The presets (docs/adapters.md, OAI30). They are only configuration, so what is
 * worth asserting is that each one reaches its own address, asks for its own
 * secret and adds only the header its provider asked for.
 */

const key = "not-a-real-key-for-a-test";

function secrets(names: string[]): { get: (name: string) => Promise<string | undefined> } {
	return {
		get: async (name: string) => {
			names.push(name);
			return name.endsWith("_API_KEY") ? key : undefined;
		},
	};
}

const ask = {
	system: "",
	messages: [{ role: "user" as const, text: "hello" }],
	tools: [],
	signal: new AbortController().signal,
};

test("OAI30 OpenRouter gets its own address and secret", async () => {
	const asked: string[] = [];
	const server = fakeModelServer([{ text: "hi" }]);
	const model = openRouter({
		model: "openai/gpt-5",
		secrets: secrets(asked),
		clock: fakeClock(),
		fetch: server,
	});
	const result = await model.complete(ask);
	expect(result.ok).toBe(true);
	expect(asked).toEqual(["OPENROUTER_API_KEY"]);
	const [sent] = server.requests;
	expect(sent?.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`);
	expect(sent?.headers["authorization"]).toBe(`Bearer ${key}`);
	expect(sent?.headers["x-opencode-session"]).toBeUndefined();
	expect(sent?.body).toEqual({
		model: "openai/gpt-5",
		stream: true,
		messages: [{ role: "user", content: "hello" }],
	});
});

test("OAI30 OpenCode Go gets its own address, secret and session header", async () => {
	const asked: string[] = [];
	const server = fakeModelServer([{ text: "hi" }]);
	const model = openCodeGo({
		model: "kimi-k3",
		session: "run-42",
		secrets: secrets(asked),
		clock: fakeClock(),
		fetch: server,
		headers: { "x-title": "Lyra" },
	});
	const result = await model.complete(ask);
	expect(result.ok).toBe(true);
	expect(asked).toEqual(["OPENCODE_GO_API_KEY"]);
	const [sent] = server.requests;
	expect(sent?.url).toBe(`${OPENCODE_GO_BASE_URL}/chat/completions`);
	expect(sent?.headers["x-opencode-session"]).toBe("run-42");
	expect(sent?.headers["x-title"]).toBe("Lyra");
});
