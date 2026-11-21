import { expect, test } from "vitest";

import { decodeCassette, replayCassette, scanForSecrets } from "./testkit/cassette.js";

/**
 * The cassettes in `cassettes/`, read the way CI reads them (CAS02 in
 * `docs/engineering-practices.md`). A cassette is a real provider's bytes once,
 * replayed forever, so the one thing that must never happen is a key or a token
 * being committed in one.
 *
 * `src/` may not import `node:fs`, so Vite hands the files over as raw text and
 * the test parses them, as the scenario test does.
 */

const files = import.meta.glob<string>("../../../cassettes/*.json", {
	query: "?raw",
	import: "default",
	eager: true,
});

function nameOf(path: string): string {
	return path.split("/").at(-1) ?? path;
}

test("CAS02 there is at least one cassette to check", () => {
	// A guard against a glob that matches nothing, which would pass the scan below
	// by having nothing to scan.
	expect(Object.keys(files).length).toBeGreaterThanOrEqual(1);
});

for (const [path, raw] of Object.entries(files)) {
	const name = nameOf(path);

	test(`CAS02 the cassette ${name} holds nothing that looks like a key`, () => {
		expect(scanForSecrets(raw)).toEqual([]);
	});

	test(`CAS02 the cassette ${name} is a cassette this build can read`, () => {
		const decoded = decodeCassette(JSON.parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		expect(decoded.value.exchanges.length).toBeGreaterThan(0);
		// A synthetic recording says so, so nobody mistakes it for a real call.
		if (decoded.value.note !== undefined && decoded.value.note.startsWith("synthetic")) {
			expect(decoded.value.note).toContain("synthetic");
		}
	});

	test(`CAS02 the cassette ${name} replays its first exchange`, async () => {
		const decoded = decodeCassette(JSON.parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		const [first] = decoded.value.exchanges;
		if (first === undefined) {
			throw new Error(`${name}: no exchanges`);
		}
		const replay = replayCassette(decoded.value);
		const response = await replay(first.request.url, {
			method: first.request.method,
			body: first.request.body,
		});
		expect(response.status).toBe(first.response.status);
		expect(await response.text()).toBe(first.response.body);
		expect(decoded.value.exchanges.length).toBeGreaterThan(0);
	});
}
