import { expect, test } from "vitest";

import { MAX_SCRIPT_BYTES, decodeScript, scriptedSlot, tokenMatches } from "./script.js";

/**
 * The rows are in `docs/playground.md`: PGS41 and PGS42.
 *
 * A smoke job runs a scripted model on the deployment, behind a header that is only
 * accepted from the smoke tenant with the exact token. The model itself is a list of turns;
 * what matters here is that anything else is refused before a run starts.
 */

test("PGS41 a script is a list of turns, and anything else is refused", () => {
	const turns = decodeScript(
		JSON.stringify([
			{
				toolCalls: [
					{ id: "c1", name: "notes_write", arguments: '{"name":"a","text":"b"}' },
				],
			},
			{ text: "done", toolCalls: [{ id: "c2", name: "finish", arguments: "{}" }] },
		]),
	);
	expect(turns.ok).toBe(true);
	if (!turns.ok) {
		return;
	}
	expect(turns.value).toHaveLength(2);
	expect(turns.value[0]?.toolCalls?.[0]).toEqual({
		id: "c1",
		name: "notes_write",
		arguments: '{"name":"a","text":"b"}',
	});

	for (const raw of [
		null,
		"",
		"{",
		"{}",
		'{"turns":[]}',
		JSON.stringify([]),
		JSON.stringify([{ nothing: true }]),
		JSON.stringify([{ toolCalls: "not a list" }]),
		JSON.stringify([{ toolCalls: [{ name: "finish" }] }]),
	]) {
		const refused = decodeScript(raw);
		expect(refused.ok, String(raw)).toBe(false);
	}

	const oversized = decodeScript(JSON.stringify([{ text: "x".repeat(MAX_SCRIPT_BYTES) }]));
	expect(oversized.ok).toBe(false);
});

test("PGS41 the scripted model answers in order, and says so when the script runs out", async () => {
	const decoded = decodeScript(
		JSON.stringify([{ toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }] }]),
	);
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}
	const slot = scriptedSlot(decoded.value);
	const request = {
		system: "s",
		messages: [],
		tools: [],
		signal: new AbortController().signal,
	} as unknown as Parameters<typeof slot.complete>[0];

	const first = await slot.complete(request);
	expect(first.ok).toBe(true);
	if (first.ok) {
		expect(first.value.toolCalls).toEqual([{ id: "c1", name: "finish", arguments: "{}" }]);
		// No cost, because no model was called: the same rule the placeholder follows.
		expect(first.value.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	}

	const second = await slot.complete(request);
	expect(second.ok).toBe(false);
	if (!second.ok) {
		expect(second.error.retryable).toBe(false);
	}
});

test("PGS42 the script token is compared exactly, and never by length alone", () => {
	expect(tokenMatches("right-token", "right-token")).toBe(true);
	expect(tokenMatches("right-token", "right-tokeN")).toBe(false);
	expect(tokenMatches("right-token", "right-toke")).toBe(false);
	expect(tokenMatches("right-token", "right-token-and-more")).toBe(false);
	expect(tokenMatches("right-token", "")).toBe(false);
	expect(tokenMatches("", "")).toBe(false);
});
