import { describe, expect, test } from "vitest";

import { systemClock, systemIds } from "./system-clock.js";

/**
 * The rows are in `docs/core-loop.md`. This file is the one place a real timer
 * is used: it is the wrapper around the host's own time, so testing it without
 * a timer is impossible, and the waits are single milliseconds rather than a
 * sleep that stands in for the code under test.
 */

describe("the system clock", () => {
	test("CLK01 now is epoch milliseconds, not seconds", () => {
		const now = systemClock().now();
		// Anything before 2023-11-14 in milliseconds is a clock reporting seconds,
		// or a clock stuck in the past. Both are worth failing on.
		expect(Number.isInteger(now)).toBe(true);
		expect(now).toBeGreaterThan(1_700_000_000_000);
	});

	test("CLK02 a sleep resolves, and one that is aborted rejects at once and stops waiting", async () => {
		const clock = systemClock();
		await expect(clock.sleep(1)).resolves.toBeUndefined();

		// A minute of real time, so a sleep that ignores the abort cannot pass by
		// finishing anyway inside the test's timeout.
		const controller = new AbortController();
		const sleeping = clock.sleep(60_000, controller.signal);
		controller.abort();
		await expect(sleeping).rejects.toThrow("sleep aborted");

		// A signal that had already fired before the sleep began takes the same path.
		await expect(clock.sleep(60_000, controller.signal)).rejects.toThrow("sleep aborted");
	});
});

describe("system ids", () => {
	test("CLK03 an id carries its prefix and 128 random bits, and repeats are impossible", () => {
		const ids = systemIds();
		const seen = new Set<string>();
		for (let index = 0; index < 1_000; index += 1) {
			const id = ids.next("e");
			expect(id).toMatch(/^e_[0-9a-f]{32}$/);
			seen.add(id);
		}
		expect(seen.size).toBe(1_000);

		// Two sources are two, not one shared sequence, so two hosts cannot collide.
		expect(systemIds().next("e")).not.toBe(systemIds().next("e"));
	});
});
