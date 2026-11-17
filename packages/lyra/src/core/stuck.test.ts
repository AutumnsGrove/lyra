import { expect, test } from "vitest";

import { createFinishTool, toolReturning, toolReturningError } from "../testkit/index.js";
import { readRecord, runHarness as harness } from "./run-harness.testing.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 5)". */

const silent = { text: "I think that is everything." };
const finish = { toolCalls: [{ id: "c1", name: "finish" }] };
const failing = (content: string) => ({
	toolCalls: [{ id: "c1", name: "read", args: {} }],
	// The tool's own text is what makes two failures "the same way".
	text: content,
});

test("STK01 a reply with no tool call is reminded and the run continues", async () => {
	const nudged = harness([silent, finish], () => [createFinishTool()]);

	const result = await nudged.run();
	expect(result).toMatchObject({ reason: "done", turns: 2 });

	const record = await readRecord(nudged.storage);
	const reminder = record.entries.find(
		(entry) => entry.type === "user_message" && entry.label === "reminder",
	);
	// The reminder is written after the silent turn, before the next request.
	expect(reminder?.type === "user_message" ? reminder.text : "").toContain("finish");
	const shape = record.entries.map((entry) => entry.type);
	expect(shape.indexOf("assistant_message")).toBeLessThan(
		record.entries.findIndex(
			(entry) => entry.type === "user_message" && entry.label === "reminder",
		),
	);
});

test("STK02 a model that keeps stopping is reminded twice and then parks stuck", async () => {
	const silentForever = harness([silent, silent, silent, silent], () => [createFinishTool()]);

	const result = await silentForever.run();
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "stopped_without_finishing",
		turns: 3,
	});

	const record = await readRecord(silentForever.storage);
	const reminders = record.entries.filter(
		(entry) => entry.type === "user_message" && entry.label === "reminder",
	);
	// Two nudges, not one and not three.
	expect(reminders).toHaveLength(2);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "stuck",
		detail: "stopped_without_finishing",
	});
});

test("STK03 a tool that fails the same way three times parks, naming it", async () => {
	const broken = harness(
		[
			failing("no such repository"),
			failing("no such repository"),
			failing("no such repository"),
		],
		() => [toolReturningError("read", "no such repository"), createFinishTool()],
	);

	const result = await broken.run();
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "repeated_failure: read",
		turns: 3,
	});

	const record = await readRecord(broken.storage);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "stuck",
		detail: "repeated_failure: read",
	});
});

test("STK04 a different failure in between, or a success, resets the count", async () => {
	// The tool's own text is what makes two failures the same or different.
	const variedContents = [
		"no such repository",
		"no such repository",
		"the network is down",
		"no such repository",
		"no such repository",
	];
	let variedIndex = 0;
	const varied = harness(
		[
			...variedContents.map((_content, position) => ({
				toolCalls: [{ id: `c${position}`, name: "read", args: {} }],
			})),
			finish,
		],
		() => [
			{
				spec: {
					name: "read",
					description: "fails variably",
					parameters: { type: "object" },
				},
				async execute() {
					const content = variedContents[variedIndex] ?? "no such repository";
					variedIndex += 1;
					return { isError: true, content };
				},
			},
			createFinishTool(),
		],
	);

	const result = await varied.run();
	// Two in a row, a different one, then two more: never three the same way.
	expect(result).toMatchObject({ reason: "done", turns: 6 });

	// A success resets it too, which is the other half of "in a row".
	let calls = 0;
	const mixed = harness(
		[
			failing("no such repository"),
			failing("no such repository"),
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			failing("no such repository"),
			failing("no such repository"),
			finish,
		],
		() => [
			{
				spec: {
					name: "read",
					description: "fails twice, then works",
					parameters: { type: "object" },
				},
				async execute() {
					calls += 1;
					return calls <= 2
						? { isError: true, content: "no such repository" }
						: { isError: false, content: "the content" };
				},
			},
			createFinishTool(),
		],
	);

	const afterSuccess = await mixed.run();
	expect(afterSuccess).toMatchObject({ reason: "done", turns: 6 });
});

test("STK05 with the safeguard off nothing is reminded and nothing parks", async () => {
	const off = harness([silent], () => [createFinishTool()]);

	const result = await off.run({ stuck: { enabled: false } });
	// It cannot report a done-check that never passed, so it ends failed and says why.
	expect(result.reason).toBe("failed");
	expect(result.reason === "failed" ? result.error?.message : "").toContain(
		"stuck safeguard is off",
	);

	const record = await readRecord(off.storage);
	expect(
		record.entries.some((entry) => entry.type === "user_message" && entry.label === "reminder"),
	).toBe(false);
	expect(record.entries.at(-1)).toMatchObject({ type: "status", state: "failed" });
});

test("STK06 cut-off replies count the same way, and three in a row park", async () => {
	const cutOff = (
		id: string,
	): { toolCalls: { id: string; name: string }[]; finishReason: "length" } => ({
		toolCalls: [{ id, name: "read" }],
		finishReason: "length",
	});
	const truncated = harness([cutOff("c1"), cutOff("c2"), cutOff("c3")], () => [
		toolReturning("read", "the content"),
		createFinishTool(),
	]);

	const result = await truncated.run();
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "stuck",
		parkedDetail: "repeated_failure: a reply cut off by the token limit",
		turns: 3,
	});
	// None of the cut-off calls ran, and each still has an error result.
	const record = await readRecord(truncated.storage);
	const results = record.entries.filter((entry) => entry.type === "tool_message");
	expect(results).toHaveLength(3);
	expect(results.every((entry) => entry.type === "tool_message" && entry.isError)).toBe(true);
});
