import { expect, test } from "vitest";

import { capFrom, refusalFor, socketRefusal, utcDay } from "./cap.js";

/**
 * The rows are in `docs/playground.md`: PGS38 and PGS39.
 *
 * The cap is the host's policy, and the check is a function so it can be driven without a
 * Durable Object: the budget is anything with a `fetch`, and the day comes from the clock.
 */

function budgetSaying(state: Record<string, unknown>): {
	asked: string[];
	fetch: (r: Request) => Promise<Response>;
} {
	const asked: string[] = [];
	return {
		asked,
		fetch: async (request) => {
			asked.push(new URL(request.url).pathname + new URL(request.url).search);
			return new Response(JSON.stringify(state), { status: 200 });
		},
	};
}

function startFrame(): Record<string, unknown> {
	return { type: "command", id: "c1", command: "start", task: "tool-table", input: "hi" };
}

test("PGS38 a start over the cap is refused with limit, and one under it is not", async () => {
	const over = budgetSaying({ day: "2026-11-26", usd: 1, unpriced: false });
	const refused = await refusalFor({
		body: startFrame(),
		budget: over,
		cap: 1,
		day: "2026-11-26",
	});
	expect(refused?.status).toBe(429);
	expect(refused?.frame).toMatchObject({
		type: "response",
		id: "c1",
		command: "start",
		ok: false,
		error: { code: "limit" },
	});
	// The request named the day it was asked about, so the object never has to guess.
	expect(over.asked).toEqual(["/status?day=2026-11-26"]);

	const under = await refusalFor({
		body: startFrame(),
		budget: budgetSaying({ day: "2026-11-26", usd: 0.5, unpriced: false }),
		cap: 1,
		day: "2026-11-26",
	});
	expect(under).toBeUndefined();
});

test("PGS39 an unpriced day refuses a start even under the cap", async () => {
	const refused = await refusalFor({
		body: startFrame(),
		budget: budgetSaying({ day: "2026-11-26", usd: 0, unpriced: true }),
		cap: 1,
		day: "2026-11-26",
	});
	expect(refused?.status).toBe(429);
	expect(String((refused?.frame.error as { message?: string }).message)).toContain("unpriced");
});

test("PGS38 only a start is checked, and only when a cap is set", async () => {
	// A follow-up continues a run that was already allowed to spend; refusing it would
	// stop a conversation mid-sentence, and the plan's rule is a new run.
	const followUp = {
		type: "command",
		id: "c2",
		command: "follow_up",
		session: "s1",
		text: "go on",
	};
	expect(
		await refusalFor({
			body: followUp,
			budget: budgetSaying({ day: "2026-11-26", usd: 5, unpriced: false }),
			cap: 1,
			day: "2026-11-26",
		}),
	).toBeUndefined();

	// No cap set is no cap: the rig runs without one rather than refusing everything.
	expect(
		await refusalFor({
			body: startFrame(),
			budget: budgetSaying({ day: "2026-11-26", usd: 5, unpriced: false }),
			cap: null,
			day: "2026-11-26",
		}),
	).toBeUndefined();
});

test("PGS38 the binding is read as money or not at all, and the day is UTC", () => {
	expect(capFrom({ LYRA_PLAYGROUND_DAY_CAP_USD: "2.5" })).toBe(2.5);
	expect(capFrom({ LYRA_PLAYGROUND_DAY_CAP_USD: " 1 " })).toBe(1);
	for (const value of [undefined, "", " ", "0", "-1", "abc", "NaN"]) {
		expect(capFrom({ LYRA_PLAYGROUND_DAY_CAP_USD: value }), String(value)).toBeNull();
	}
	// A timestamp late in the UTC day is still that day; one past midnight is the next.
	expect(utcDay(Date.UTC(2026, 10, 26, 23, 59, 59))).toBe("2026-11-26");
	expect(utcDay(Date.UTC(2026, 10, 27, 0, 0, 1))).toBe("2026-11-27");
});

test("PGS38 a budget that throws or answers nonsense refuses the start", async () => {
	const throwing = {
		fetch: async () => {
			throw new Error("the object is gone");
		},
	};
	const refused = await refusalFor({
		body: startFrame(),
		budget: throwing,
		cap: 1,
		day: "2026-11-26",
	});
	expect(refused?.status).toBe(429);
	expect((refused?.frame.error as { message?: string }).message).toContain("could not be read");

	const nonsense = await refusalFor({
		body: startFrame(),
		budget: { fetch: async () => new Response("not json", { status: 200 }) },
		cap: 1,
		day: "2026-11-26",
	});
	expect(nonsense?.status).toBe(429);
});

test("PGS38 a start on a socket is refused the same way as one over HTTP", async () => {
	// A socket command does not pass through the Worker's `fetch`, so without this check a
	// client that upgraded could start runs after the day was done (found in review on #99).
	const budget = budgetSaying({ day: "2026-11-26", usd: 1, unpriced: false });
	const sent = await socketRefusal({
		message: JSON.stringify({
			type: "command",
			id: "c9",
			command: "start",
			task: "tool-table",
			input: "hi",
		}),
		budget,
		cap: 1,
		day: "2026-11-26",
	});
	expect(sent).toBeDefined();
	expect(JSON.parse(sent ?? "{}")).toMatchObject({
		type: "response",
		id: "c9",
		ok: false,
		error: { code: "limit" },
	});

	// A hello, a follow-up, or a line that is not JSON is the session's business, not the
	// cap's: the check leaves it alone.
	for (const message of [
		JSON.stringify({ type: "hello", version: 1, client: "test", capabilities: [] }),
		JSON.stringify({
			type: "command",
			id: "c9",
			command: "follow_up",
			session: "s1",
			text: "go",
		}),
		"not json",
	]) {
		expect(
			await socketRefusal({ message, budget, cap: 1, day: "2026-11-26" }),
			message,
		).toBeUndefined();
	}
});
