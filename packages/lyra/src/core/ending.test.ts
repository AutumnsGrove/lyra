import { expect, test } from "vitest";

import { toolReturning, toolReturningError } from "../testkit/index.js";
import { readRecord, runHarness as harness } from "./run-harness.testing.js";

/** The rows are in `docs/core-loop.md`, "Rows (step 2's ending, issue #106)". */

const answering = { text: "Fireside is a place to think out loud." };

test("LOOP26 a reply with no tool call ends the run when the recipe says so", async () => {
	const replying = harness([answering, { text: "never asked" }], () => [
		toolReturning("look", "a page"),
	]);

	const result = await replying.run({ ending: "reply" });
	// One turn: the reply is the answer, so nothing asks the model for a second one.
	expect(result).toMatchObject({ reason: "done", turns: 1 });

	const record = await readRecord(replying.storage);
	expect(
		record.entries.some((entry) => entry.type === "user_message" && entry.label === "reminder"),
	).toBe(false);
	expect(record.entries.at(-1)).toMatchObject({ type: "status", state: "done" });
});

test("LOOP27 a call, then the answer, ends the run without a nudge", async () => {
	const working = harness(
		[{ toolCalls: [{ id: "c1", name: "look", args: {} }] }, answering, { text: "never asked" }],
		() => [toolReturning("look", "a page", { safeToRepeat: true })],
	);

	const result = await working.run({ ending: "reply" });
	expect(result).toMatchObject({ reason: "done", turns: 2 });

	const record = await readRecord(working.storage);
	// The call ran and the reply after it is what ended the run: no reminder sits
	// between them, because the model did exactly what it was asked to.
	expect(record.entries.map((entry) => entry.type)).toContain("tool_message");
	expect(
		record.entries.some((entry) => entry.type === "user_message" && entry.label === "reminder"),
	).toBe(false);
});

test("LOOP28 a tool failing the same way three times still parks the run", async () => {
	const broken = harness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c3", name: "read", args: {} }] },
		],
		() => [toolReturningError("read", "no such repository")],
	);

	// Only the "stopped without finishing" nudge is meaningless under a reply's
	// ending: a loop that cannot progress still parks rather than spending an
	// allowance on it.
	const result = await broken.run({ ending: "reply" });
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "repeated_failure: read",
		turns: 3,
	});
});

test("LOOP29 a reply cut off by the token limit still ends the run, and says so", async () => {
	const cutOff = harness([{ text: "the answer is", finishReason: "length" }], () => []);

	const result = await cutOff.run({ ending: "reply" });
	// The reply is the deliverable, so a truncated one is still the reply: the
	// person's conversation ends with what the model said rather than parking on a
	// limit the recipe chose its own ending for.
	expect(result).toMatchObject({ reason: "done", turns: 1 });

	const record = await readRecord(cutOff.storage);
	const assistant = record.entries.find((entry) => entry.type === "assistant_message");
	// A caller that cares about the cut reads it here rather than guessing.
	expect(assistant).toMatchObject({ finishReason: "length" });
});

test("RCP11 an ending this build cannot honour is not one, so the run keeps the default", async () => {
	// A `RunConfig` built by hand never passes through `defineRecipe`, so the loop has to
	// answer for the typo itself rather than trusting the type: the default applies, and
	// a run does not refuse to start over a setting it can read (the rule a bad
	// `maxParallelCalls` follows).
	const nudged = harness(
		[{ text: "nothing" }, { text: "nothing" }, { text: "nothing" }, { text: "nothing" }],
		() => [],
	);

	const result = await nudged.run({ ending: "prose" as "reply" });
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stuck" });
});
