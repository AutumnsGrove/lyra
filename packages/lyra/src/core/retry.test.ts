import { expect, test } from "vitest";

import { createFinishTool } from "../testkit/index.js";
import { drive, readRecord, runHarness as harness, until } from "./run-harness.testing.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 4)". */

const finishTurn = (failures: number, options: { retryable?: boolean } = {}) => ({
	toolCalls: [{ id: "c1", name: "finish" }],
	failures: Array.from({ length: failures }, () => ({
		code: "provider_error" as const,
		message: "the provider is down",
		retryable: options.retryable ?? true,
	})),
});

/** A step larger than the longest retry delay, so one advance clears one wait. */
const PAST_EVERY_DELAY_MS = 20_000;

test("RTY01 a retryable failure succeeds on the second attempt", async () => {
	const flaky = harness([finishTurn(1)], () => [createFinishTool()]);

	const result = await drive(flaky.clock, flaky.run(), PAST_EVERY_DELAY_MS);
	expect(result).toMatchObject({ reason: "done", turns: 1 });
	// The first attempt failed and the second answered: both were made.
	expect(flaky.model.requests).toHaveLength(2);
	// A retry is the same step, not a second one.
	expect(result.turns).toBe(1);

	const record = await readRecord(flaky.storage);
	const assistant = record.entries.find((entry) => entry.type === "assistant_message");
	expect(assistant).toMatchObject({ type: "assistant_message", retries: 1 });

	const retries = flaky.events.filter((event) => event.type === "retry");
	expect(retries).toHaveLength(1);
	expect(retries[0]).toMatchObject({ attempt: 1, delayMs: 1_000 });
});

test("RTY02 three retries with growing delays, then the run parks model_unavailable", async () => {
	const down = harness([finishTurn(4)], () => [createFinishTool()]);

	const result = await drive(down.clock, down.run(), PAST_EVERY_DELAY_MS);
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "model_unavailable",
	});
	expect(result.parkedDetail?.startsWith("provider_error:")).toBe(true);
	expect(down.model.requests).toHaveLength(4);

	const retries = down.events.filter((event) => event.type === "retry");
	expect(retries.map((event) => (event.type === "retry" ? event.delayMs : 0))).toEqual([
		1_000, 4_000, 16_000,
	]);
	expect(down.clock.pending()).toBe(0);

	const record = await readRecord(down.storage);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "model_unavailable",
	});
});

test("RTY03 a non-retryable failure is not retried and ends the run failed", async () => {
	const broken = harness([finishTurn(1, { retryable: false })], () => [createFinishTool()]);

	const result = await broken.run();
	expect(result.reason).toBe("failed");
	expect(result.reason === "failed" ? result.error?.code : "").toBe("provider_error");
	// Asked once, and nothing waited on the clock.
	expect(broken.model.requests).toHaveLength(1);
	expect(broken.events.some((event) => event.type === "retry")).toBe(false);
	expect(broken.clock.pending()).toBe(0);
});

test("RTY04 a retryAfterMs is a floor under the delay, on the fake clock", async () => {
	const asked = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "finish" }],
				failures: [{ code: "timeout", message: "come back later", retryAfterMs: 5_000 }],
			},
		],
		() => [createFinishTool()],
	);
	const started = asked.clock.now();

	const result = await drive(asked.clock, asked.run(), PAST_EVERY_DELAY_MS);
	expect(result.reason).toBe("done");

	const retry = asked.events.find((event) => event.type === "retry");
	// The provider's own wait wins over the shorter default delay.
	expect(retry).toMatchObject({ delayMs: 5_000 });
	expect(asked.clock.now() - started).toBeGreaterThanOrEqual(5_000);
});

test("RTY05 a stop during the backoff parks the run stopped", async () => {
	const controller = new AbortController();
	const waiting = harness([finishTurn(1)], () => [createFinishTool()]);

	const running = waiting.run({ signal: controller.signal });
	await until(() => waiting.events.some((event) => event.type === "retry"));
	// The run is waiting out the delay, which is the moment this row is about.
	expect(waiting.events.some((event) => event.type === "retry")).toBe(true);
	controller.abort();

	const result = await running;
	expect(result).toMatchObject({ reason: "parked", parkedReason: "stopped" });
	// The wait was cancelled rather than retried after it.
	expect(waiting.model.requests).toHaveLength(1);
	expect(waiting.clock.pending()).toBe(0);
});

test("RTY06 a fallback model is used after the retries and recorded", async () => {
	const rescued = harness([finishTurn(4)], () => [createFinishTool()]);

	const result = await drive(
		rescued.clock,
		rescued.run({ fallbackModel: "backup/model" }),
		PAST_EVERY_DELAY_MS,
	);
	expect(result.reason).toBe("done");
	// The failed turn, then the same turn answered by the fallback.
	expect(result.turns).toBe(2);
	expect(rescued.model.requests.at(-1)?.model).toBe("backup/model");

	const record = await readRecord(rescued.storage);
	const fallback = record.entries.find((entry) => entry.type === "fallback");
	expect(fallback).toMatchObject({ from: "default", to: "backup/model" });
	expect(fallback?.type === "fallback" ? fallback.reason : "").toContain("provider_error");

	const events = rescued.events.filter((event) => event.type === "fallback");
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ from: "default", to: "backup/model" });
});

test("RTY07 a fallback that also fails parks model_unavailable", async () => {
	const doomed = harness([finishTurn(8)], () => [createFinishTool()]);

	const result = await drive(
		doomed.clock,
		doomed.run({ fallbackModel: "backup/model" }),
		PAST_EVERY_DELAY_MS,
	);
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "model_unavailable",
	});
	// Four attempts on each model, and three retries for each of them.
	expect(doomed.model.requests).toHaveLength(8);
	const retries = doomed.events.filter((event) => event.type === "retry");
	expect(retries).toHaveLength(6);
	expect(doomed.events.filter((event) => event.type === "fallback")).toHaveLength(1);
});
