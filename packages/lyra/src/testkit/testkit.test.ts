import { expect, test } from "vitest";

import type { ModelRequest } from "../core/model.js";
import { memoryStorage } from "../adapters/memory/storage.js";
import { fakeClock } from "./clock.js";
import { scriptedModel } from "./model.js";
import { failingStorage } from "./storage.js";
import {
	createFinishTool,
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
} from "./tools.js";

/** The rows are in `docs/engineering-practices.md`, "Spec rows: the testkit". */

function request(
	messages: ModelRequest["messages"],
	signal = new AbortController().signal,
): ModelRequest {
	return { system: "you are a test", messages, tools: [], signal };
}

const userTurn: ModelRequest["messages"][number] = { role: "user", text: "do the thing" };

test("KIT01 time moves only when a test advances it, and a sleep resolves at its deadline", async () => {
	const clock = fakeClock(1_000);
	expect(clock.now()).toBe(1_000);

	let answered = false;
	const sleeping = clock.sleep(500).then(() => {
		answered = true;
	});
	await Promise.resolve();
	expect(answered).toBe(false);
	expect(clock.pending()).toBe(1);

	clock.advance(499);
	await Promise.resolve();
	expect(answered).toBe(false);

	clock.advance(1);
	await sleeping;
	expect(answered).toBe(true);
	expect(clock.now()).toBe(1_500);
	expect(clock.pending()).toBe(0);
});

test("KIT01 an aborted sleep rejects, leaves nothing pending, and a zero delay needs no advance", async () => {
	const clock = fakeClock();
	const controller = new AbortController();

	const sleeping = clock.sleep(1_000, controller.signal);
	expect(clock.pending()).toBe(1);
	controller.abort();
	await expect(sleeping).rejects.toThrow("sleep aborted");
	expect(clock.pending()).toBe(0);

	// A signal that had already fired takes the same path without registering.
	await expect(clock.sleep(1_000, controller.signal)).rejects.toThrow("sleep aborted");
	expect(clock.pending()).toBe(0);

	await expect(clock.sleep(0)).resolves.toBeUndefined();
});

test("KIT02 the reply is chosen by conversation position, and a re-asked request gets it again", async () => {
	const clock = fakeClock();
	const model = scriptedModel(
		[
			{ text: "first answer" },
			{
				reasoning: "thinking it through",
				toolCalls: [
					{ id: "c1", name: "read", args: { number: 12 } },
					{ id: "c2", name: "raw", args: "{oops" },
					{ id: "c3", name: "no_args" },
				],
			},
		],
		{ clock, model: "scripted/test" },
	);

	const first = await model.complete(request([userTurn]));
	expect(first.ok && first.value.text).toBe("first answer");
	expect(first.ok && first.value.finishReason).toBe("stop");

	const beforeSecond = request([
		userTurn,
		{ role: "assistant", text: "first answer", toolCalls: [] },
		{ role: "tool", toolCallId: "c1", content: "ok", isError: false },
	]);
	const second = await model.complete(beforeSecond);
	expect(second.ok).toBe(true);
	if (!second.ok) {
		return;
	}
	// An object becomes JSON text; a string is passed through, so invalid JSON is reachable.
	expect(second.value.toolCalls).toEqual([
		{ id: "c1", name: "read", arguments: '{"number":12}' },
		{ id: "c2", name: "raw", arguments: "{oops" },
		{ id: "c3", name: "no_args", arguments: "{}" },
	]);
	// Reasoning is carried when the script offers it, and left out when it does not.
	expect(second.value.reasoning).toBe("thinking it through");
	expect(second.value.finishReason).toBe("tool_calls");
	expect(second.value.model).toBe("scripted/test");

	// Re-asking the same conversation, which is what a resume does, gets the same
	// answer rather than the turn after it.
	const again = await model.complete(beforeSecond);
	expect(again).toEqual(second);

	expect(model.requests).toHaveLength(3);
	expect(model.requests[1]).toBe(beforeSecond);
});

test("KIT03 a delay waits for the clock, and aborts with the run", async () => {
	const clock = fakeClock();
	const model = scriptedModel([{ text: "late", delayMs: 200 }], { clock });

	let settled = false;
	const answering = model.complete(request([userTurn])).then((result) => {
		settled = true;
		return result;
	});
	await Promise.resolve();
	expect(settled).toBe(false);

	clock.advance(200);
	const answered = await answering;
	expect(answered.ok && answered.value.text).toBe("late");

	const controller = new AbortController();
	const blocked = model.complete(request([userTurn], controller.signal));
	controller.abort();
	await expect(blocked).rejects.toThrow("sleep aborted");
});

test("KIT03 failures come back in order before the turn succeeds", async () => {
	const clock = fakeClock();
	const model = scriptedModel(
		[
			{
				text: "finally",
				failures: [{ message: "first try" }, { code: "timeout", retryAfterMs: 50 }],
			},
		],
		{ clock },
	);

	const first = await model.complete(request([userTurn]));
	expect(first.ok).toBe(false);
	if (!first.ok) {
		expect(first.error).toEqual({
			code: "provider_error",
			message: "first try",
			retryable: true,
		});
	}

	const second = await model.complete(request([userTurn]));
	expect(second.ok).toBe(false);
	if (!second.ok) {
		expect(second.error.retryAfterMs).toBe(50);
		expect(second.error.retryable).toBe(true);
	}

	const third = await model.complete(request([userTurn]));
	expect(third.ok && third.value.text).toBe("finally");
});

test("KIT03 sleeps due in one advance resolve in deadline order, not insertion order", async () => {
	const clock = fakeClock();
	const order: string[] = [];

	// The later deadline is registered first, so an `advance` that walks its own
	// insertion order resolves them backwards and this fails.
	void clock.sleep(20).then(() => {
		order.push("20");
	});
	void clock.sleep(10).then(() => {
		order.push("10");
	});

	clock.advance(30);
	await Promise.resolve();

	expect(order).toEqual(["10", "20"]);
	expect(clock.pending()).toBe(0);
});

test("KIT03 a script with nothing left is a loud non-retryable error, not a loop", async () => {
	const model = scriptedModel([{ text: "only turn" }], { clock: fakeClock() });
	const answered = await model.complete(
		request([userTurn, { role: "assistant", text: "only turn", toolCalls: [] }]),
	);
	expect(answered.ok).toBe(false);
	if (!answered.ok) {
		expect(answered.error.code).toBe("internal");
		expect(answered.error.retryable).toBe(false);
		expect(answered.error.message).toMatch(/no turn 2/);
	}
});

test("KIT04 exactly the chosen append fails, stores nothing, and leaves the rest alone", async () => {
	const inner = memoryStorage();
	const storage = failingStorage(inner, { failOn: 2 });

	const first = await storage.append('{"n":1}');
	const second = await storage.append('{"n":2}');
	const third = await storage.append('{"n":3}');

	expect(first).toEqual({ ok: true, value: { seq: 0 } });
	expect(second.ok).toBe(false);
	expect(third).toEqual({ ok: true, value: { seq: 1 } });
	expect(storage.appends()).toBe(3);
	expect(inner.saved()).toEqual(['{"n":1}', '{"n":3}']);
	expect(await storage.read()).toEqual({ ok: true, value: ['{"n":1}', '{"n":3}'] });
});

test("KIT05 the clock reports a timer that was never resolved", () => {
	const clock = fakeClock();
	expect(clock.pending()).toBe(0);
	void clock.sleep(1_000);
	expect(clock.pending()).toBe(1);
	clock.advance(1_000);
	expect(clock.pending()).toBe(0);
});

test("KIT06 the scripted tools answer as their names say", async () => {
	const clock = fakeClock();
	const signal = new AbortController().signal;
	const ctx = { signal, runId: "run-1", callId: "c1" };

	expect(await toolReturning("read", "content").execute({}, ctx)).toEqual({
		isError: false,
		content: "content",
	});
	expect(
		await toolReturning("read", "content", { details: { issue: 12 } }).execute({}, ctx),
	).toEqual({
		isError: false,
		content: "content",
		details: { issue: 12 },
	});
	expect(await toolReturningError("read", "no such issue").execute({}, ctx)).toEqual({
		isError: true,
		content: "no such issue",
	});
	await expect(toolThatThrows("read").execute({}, ctx)).rejects.toThrow("read threw");
	expect(await createFinishTool().execute({}, ctx)).toEqual({
		isError: false,
		content: "finished",
		done: true,
	});
	expect(createFinishTool().spec.name).toBe("finish");

	// A slow tool finishes only when the clock says so.
	const slow = toolTakingTime("slow", 300, clock);
	let finished = false;
	const running = slow.execute({}, ctx).then((outcome) => {
		finished = true;
		return outcome;
	});
	await Promise.resolve();
	expect(finished).toBe(false);
	clock.advance(300);
	expect(await running).toEqual({ isError: false, content: "slow finished after 300ms" });

	expect(toolReturning("safe", "x", { safeToRepeat: true }).safeToRepeat).toBe(true);
	expect(toolReturning("unsafe", "x").safeToRepeat).toBeUndefined();
});
