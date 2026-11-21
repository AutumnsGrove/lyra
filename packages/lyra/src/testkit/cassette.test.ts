import { expect, test } from "vitest";

import { counterIds } from "../adapters/memory/ids.js";
import { memoryStorage } from "../adapters/memory/storage.js";
import type { RunEvent } from "../core/events.js";
import type { ModelSlot } from "../core/model.js";
import { runTask } from "../core/run.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
import { createOpenAIChatModel } from "../adapters/openai/model.js";
import { fakeClock, type FakeClock } from "./clock.js";
import {
	decodeCassette,
	encodeCassette,
	recordingFetch,
	replayCassette,
	scanForSecrets,
} from "./cassette.js";
import { fakeModelServer } from "./fake-model-server.js";
import { createFinishTool, toolReturning } from "./tools.js";

/**
 * Cassettes (docs/engineering-practices.md, CAS01 to CAS03; decision 65). What
 * matters is that a recording is enough to reproduce a run exactly, and that
 * nothing secret can get into one.
 */

const KEY = "not-a-real-key-for-a-test";

function modelOver(
	fetchLike: (
		url: string,
		init?: {
			method?: string;
			headers?: Record<string, string>;
			body?: string;
			signal?: AbortSignal;
		},
	) => Promise<Response>,
	clock: FakeClock,
): ModelSlot {
	return createOpenAIChatModel({
		baseUrl: "https://fake.test/v1",
		model: "scripted/model",
		secrets: { get: async () => KEY },
		keyName: "MODEL_KEY",
		fetch: fetchLike as typeof fetch,
		clock,
	});
}

interface RunOutcome {
	result: Awaited<ReturnType<typeof runTask>>;
	record: LoadedRecord;
	events: RunEvent[];
}

async function runOnce(model: ModelSlot): Promise<RunOutcome> {
	const clock = fakeClock();
	const storage = memoryStorage();
	const events: RunEvent[] = [];
	const result = await runTask({
		runId: "run-1",
		task: "test-task",
		host: "test-host",
		input: "do the thing",
		system: "you are a test",
		tools: [toolReturning("read", "the file"), createFinishTool()],
		model,
		storage,
		clock,
		ids: counterIds(),
		onEvent: (event) => {
			events.push(event);
		},
	});
	const saved = await storage.read();
	if (!saved.ok) {
		throw new Error(saved.error.message);
	}
	const loaded = loadRecord(saved.value);
	if (!loaded.ok) {
		throw new Error(loaded.error.message);
	}
	return { result, record: loaded.value, events };
}

test("CAS01 a recorded run replays to the same record", async () => {
	const turns = [
		{ text: "reading it now" },
		{ toolCalls: [{ id: "c1", name: "read", args: { path: "/a.txt" } }] },
		{ toolCalls: [{ id: "c2", name: "finish", args: {} }] },
	];
	const server = fakeModelServer(turns);
	const recorder = recordingFetch(async (url, init) => server(url, init), {
		note: "synthetic: made from the fake model server",
	});

	const first = await runOnce(modelOver(recorder, fakeClock()));
	expect(first.result.reason).toBe("done");
	expect(recorder.exchanges).toHaveLength(3);
	// The key is nowhere in what was recorded: the header is dropped at record time.
	for (const exchange of recorder.exchanges) {
		expect(Object.keys(exchange.request.headers)).not.toContain("authorization");
		expect(JSON.stringify(exchange)).not.toContain(KEY);
	}

	// Through a file and back, because that is what a cassette is.
	const written = encodeCassette(recorder.cassette());
	const decoded = decodeCassette(JSON.parse(written));
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}
	expect(decoded.value.note).toContain("synthetic");

	const replay = replayCassette(decoded.value);
	const second = await runOnce(modelOver(replay, fakeClock()));
	expect(replay.unused()).toEqual([]);
	expect(second.result.reason).toBe(first.result.reason);
	expect(second.record.entries).toEqual(first.record.entries);
});

test("CAS01 a cassette that is not a cassette is refused by field", () => {
	expect(decodeCassette("nope").ok).toBe(false);
	expect(decodeCassette({}).ok).toBe(false);
	const missingBody = decodeCassette({
		exchanges: [{ request: { url: "u", method: "POST", body: "" }, response: { status: 200 } }],
	});
	expect(missingBody.ok).toBe(false);
	if (!missingBody.ok) {
		expect(missingBody.error.message).toContain("response.body");
	}
});

test("CAS02 the scan finds every shape of key", () => {
	const keys = [{ name: "A_TEST_KEY", value: "the-exact-value-of-a-key" }];
	const hits = scanForSecrets(
		[
			"a key sk-abcdefghijklmnopqrstuvwx",
			"Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
			"b64 " + "QUJD".repeat(20),
			"hex " + "a1b2c3d4e5f6".repeat(6),
			"exact the-exact-value-of-a-key",
		].join("\n"),
		{ keys },
	);
	const found = hits.map((hit) => hit.what).join(", ");
	for (const what of [
		"an sk- key",
		"a bearer token",
		"a long base64 run",
		"a long hex run",
		"the value of A_TEST_KEY",
	]) {
		expect(found).toContain(what);
	}
	// A clean recording has nothing to find, which is what makes the check usable.
	expect(scanForSecrets('{"text":"hello, this is a normal reply"}', { keys })).toEqual([]);
});

test("CAS02 a contaminated cassette is caught, so the check can fail", () => {
	const contaminated = {
		exchanges: [
			{
				request: {
					url: "https://fake.test/v1/chat/completions",
					method: "POST",
					headers: {},
					body: "",
				},
				response: { status: 200, headers: {}, body: "data: sk-live-abcdefghijklmnop\n\n" },
			},
		],
	};
	const hits = scanForSecrets(JSON.stringify(contaminated));
	expect(hits.length).toBeGreaterThan(0);
	expect(hits[0]?.what).toBe("an sk- key");
});

test("CAS03 a request the cassette has no exchange for fails clearly", async () => {
	const replay = replayCassette({ exchanges: [] });
	await expect(
		replay("https://fake.test/v1/chat/completions", { method: "POST", body: "{}" }),
	).rejects.toThrow(
		"the cassette has no exchange for POST https://fake.test/v1/chat/completions",
	);
});

test("CAS03 an exchange is used once, so a retried turn needs its own recording", async () => {
	const exchange = {
		request: {
			url: "https://fake.test/v1/chat/completions",
			method: "POST",
			headers: {},
			body: "{}",
		},
		response: { status: 200, headers: {}, body: "data: [DONE]\n\n" },
	};
	const replay = replayCassette({ exchanges: [exchange] });
	const init = { method: "POST", body: "{}" };
	await replay(exchange.request.url, init);
	await expect(replay(exchange.request.url, init)).rejects.toThrow("no exchange");
});
