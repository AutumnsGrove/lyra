import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import fc from "fast-check";
import { expect, test } from "vitest";

import type { FixtureSession } from "./testing/fixture-session.testing.js";

/**
 * CFL00 in `docs/adapters.md`. This is the first workerd test, so it settles the
 * two things the planning record left for it: that a Durable Object runs under the
 * plugin with real storage, and whether fast-check runs in workerd at all
 * (decision 103). The second test is deliberately trivial; it is a tool check, not
 * a property worth keeping.
 */

test("CFL00 a Durable Object runs under the plugin", async () => {
	const id = env.FIXTURE_SESSION.idFromName("smoke");
	const stub = env.FIXTURE_SESSION.get(id);

	const first = await stub.fetch("http://fixture/");
	expect(await first.text()).toBe("fixture session 1");
	const second = await stub.fetch("http://fixture/");
	expect(await second.text()).toBe("fixture session 2");

	await runInDurableObject(stub, async (_instance: FixtureSession, state: DurableObjectState) => {
		expect(state.storage).toBeDefined();
	});
});

test("CFL00 fast-check runs inside workerd", () => {
	let seen = 0;
	fc.assert(
		fc.property(fc.integer(), (value) => {
			seen += 1;
			expect(Number.isInteger(value + 1)).toBe(true);
		}),
		{ numRuns: 50 },
	);
	expect(seen).toBe(50);
});
