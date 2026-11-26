import { describe, expect, it } from "vitest";

import { capLine, statusWords } from "./words.js";

describe("statusWords", () => {
	it("says what a running, finished and idle run is doing in a person's words", () => {
		expect(statusWords({ state: "running" })).toMatchObject({ tone: "busy", label: "Working" });
		expect(statusWords({ state: "done" })).toMatchObject({ tone: "ok", label: "Done" });
		expect(statusWords({ state: "idle" })).toMatchObject({ tone: "quiet", label: "Ready" });
	});

	it("names what a parked run waits for instead of the protocol's code", () => {
		const waiting = statusWords({ state: "parked", detail: "waiting_for_person" });
		expect(waiting.tone).toBe("attention");
		expect(waiting.label).toBe("Waiting for you");
		expect(waiting.hint).not.toContain("_");
	});

	it("humanises a code it does not know rather than showing it raw", () => {
		const failed = statusWords({ state: "failed", detail: "some_new_reason" });
		expect(failed.tone).toBe("bad");
		expect(failed.hint).toBe("some new reason");
	});

	it("carries turns and cost into the hint, and cost only when the provider reported one", () => {
		expect(statusWords({ state: "done", turns: 3, costUsd: 0.0123 }).hint).toBe(
			"3 turns · $0.0123",
		);
		expect(statusWords({ state: "done", turns: 1 }).hint).toBe("1 turn");
	});
});

describe("capLine", () => {
	it("is nothing when the deployment set no cap", () => {
		expect(capLine({ day: "d", usd: 1, unpriced: false, cap: null })).toBeUndefined();
	});

	it("gives the fraction spent, clamped for a bar, and flags a cap that is reached", () => {
		const half = capLine({ day: "d", usd: 0.5, unpriced: false, cap: 1 });
		expect(half).toMatchObject({ fraction: 0.5, over: false });
		expect(half?.text).toContain("$0.5000 of $1.00");
		expect(capLine({ day: "d", usd: 3, unpriced: false, cap: 1 })).toMatchObject({
			fraction: 1,
			over: true,
		});
	});

	it("explains an unpriced day as a block, not as a number", () => {
		const line = capLine({ day: "d", usd: 0, unpriced: true, cap: 1 });
		expect(line?.over).toBe(true);
		expect(line?.text).toContain("no new run starts until UTC midnight");
	});
});
