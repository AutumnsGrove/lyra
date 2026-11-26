import { expect, test } from "vitest";

import { Budget, type BudgetStorage } from "./budget.js";

/**
 * The rows are in `docs/playground.md`: PGS37 to PGS39.
 *
 * The object holds one tenant's day: what it has spent, and whether every reply it saw
 * reported a cost. The fake is a `Map`, so a second object over the same map is a rebuild.
 */

function memoryBudget(): { storage: BudgetStorage; map: Map<string, unknown> } {
	const map = new Map<string, unknown>();
	const storage: BudgetStorage = {
		async get(key) {
			return map.get(key);
		},
		async put(key, value) {
			map.set(key, value);
		},
	};
	return { storage, map };
}

function request(path: string, body?: unknown, method = "POST"): Request {
	return new Request(`https://budget.test${path}`, {
		method: body === undefined ? method : "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

test("PGS37 a day's spend adds up, and a new day starts at zero", async () => {
	const { storage } = memoryBudget();
	const budget = new Budget({ storage });

	await budget.fetch(request("/spend", { day: "2026-11-26", amount: 0.25 }));
	await budget.fetch(request("/spend", { day: "2026-11-26", amount: 0.5 }));
	const today = await budget.fetch(request("/status?day=2026-11-26", undefined, "GET"));
	expect(await body(today)).toEqual({ day: "2026-11-26", usd: 0.75, unpriced: false });

	// The first write of a new UTC day resets the counter, because the cap is per day.
	await budget.fetch(request("/spend", { day: "2026-11-27", amount: 0.1 }));
	const tomorrow = await budget.fetch(request("/status?day=2026-11-27", undefined, "GET"));
	expect(await body(tomorrow)).toEqual({ day: "2026-11-27", usd: 0.1, unpriced: false });

	// The day the person is no longer in reads as empty for that day, rather than as
	// yesterday's spend: the status is asked with the day it is for.
	const yesterday = await budget.fetch(request("/status?day=2026-11-26", undefined, "GET"));
	expect(await body(yesterday)).toEqual({ day: "2026-11-26", usd: 0, unpriced: false });
});

test("PGS38 a day marked unpriced stays unpriced, and a new day clears it", async () => {
	const { storage } = memoryBudget();
	const budget = new Budget({ storage });

	await budget.fetch(request("/spend", { day: "2026-11-26", amount: 0.2 }));
	await budget.fetch(request("/unpriced", { day: "2026-11-26" }));
	const marked = await budget.fetch(request("/status?day=2026-11-26", undefined, "GET"));
	expect(await body(marked)).toEqual({ day: "2026-11-26", usd: 0.2, unpriced: true });

	// A spend after the mark does not unmark it: one reply with no cost is enough for the
	// rest of the day, because the total can no longer be trusted.
	await budget.fetch(request("/spend", { day: "2026-11-26", amount: 0.1 }));
	expect(
		await body(await budget.fetch(request("/status?day=2026-11-26", undefined, "GET"))),
	).toMatchObject({ usd: 0.3, unpriced: true });

	await budget.fetch(request("/status?day=2026-11-27", undefined, "GET"));
	const tomorrow = await budget.fetch(request("/status?day=2026-11-27", undefined, "GET"));
	expect(await body(tomorrow)).toEqual({ day: "2026-11-27", usd: 0, unpriced: false });
});

test("PGS39 a spend that is not money, or a day that is not a day, is refused", async () => {
	const { storage, map } = memoryBudget();
	const budget = new Budget({ storage });

	for (const entry of [
		{ day: "2026-11-26", amount: -1 },
		{ day: "2026-11-26", amount: Number.NaN },
		{ day: "2026-11-26", amount: "0.1" },
		{ amount: 0.1 },
		{ day: "not-a-day", amount: 0.1 },
		{ day: "2026-11-26 10:00", amount: 0.1 },
	]) {
		const response = await budget.fetch(request("/spend", entry));
		expect(response.status, JSON.stringify(entry)).toBe(400);
		expect((await body(response))["error"]).toMatchObject({ code: "bad_request" });
	}
	expect(map.size).toBe(0);

	// Malformed JSON is the same refusal, not a throw.
	const broken = await budget.fetch(
		new Request("https://budget.test/spend", { method: "POST", body: "{" }),
	);
	expect(broken.status).toBe(400);
});

test("PGS37 a rebuilt object keeps the day it was counting", async () => {
	const { storage } = memoryBudget();
	await new Budget({ storage }).fetch(request("/spend", { day: "2026-11-26", amount: 0.4 }));

	const rebuilt = new Budget({ storage });
	const status = await rebuilt.fetch(request("/status?day=2026-11-26", undefined, "GET"));
	expect(await body(status)).toEqual({ day: "2026-11-26", usd: 0.4, unpriced: false });
});
