import { describe, expect, test } from "vitest";

import type { StorageSlot } from "../core/slots.js";

/**
 * The storage contract, run against every adapter (docs/adapters.md, STO01 to
 * STO04). The in-memory adapter runs it now, and the Cloudflare adapter in step 4
 * runs the very same cases, so the two cannot drift apart in the details a caller
 * depends on: ordering, `seq`, an empty read, and what an over-long line does.
 *
 * It is a function rather than a test file of its own because the same cases run
 * in more than one place, and each adapter's own test file is where its factory
 * belongs.
 */

export interface StorageUnderTest {
	/** Shown in the test names, so a failure says which adapter broke. */
	name: string;
	/**
	 * The adapter, with a line limit the contract can test. The limit is the
	 * adapter's own: always under the host's hard limit and above the record's
	 * 1 MiB entry cap (decision 90).
	 */
	create(options: { maxLineBytes: number }): StorageSlot;
}

export function storageContract(underTest: StorageUnderTest): void {
	describe(`the storage contract: ${underTest.name}`, () => {
		const fresh = (maxLineBytes = 1_048_576): StorageSlot => underTest.create({ maxLineBytes });

		test("STO01 appends count up from zero and read returns them in order", async () => {
			const storage = fresh();
			const first = await storage.append('{"n":1}');
			const second = await storage.append('{"n":2}');
			const third = await storage.append('{"n":3}');

			expect(first).toEqual({ ok: true, value: { seq: 0 } });
			expect(second).toEqual({ ok: true, value: { seq: 1 } });
			expect(third).toEqual({ ok: true, value: { seq: 2 } });

			const read = await storage.read();
			expect(read).toEqual({ ok: true, value: ['{"n":1}', '{"n":2}', '{"n":3}'] });

			// What a caller reads is a copy: changing it cannot change the record.
			if (read.ok) {
				read.value.push("a line that was never saved");
			}
			const again = await storage.read();
			expect(again.ok && again.value).toHaveLength(3);
		});

		test("STO02 read on empty storage is an empty list, not an error", async () => {
			expect(await fresh().read()).toEqual({ ok: true, value: [] });
		});

		test("STO03 awkward lines round-trip, and a line over the limit stores nothing", async () => {
			const storage = fresh();
			const awkward = 'a line with \n a newline, \u2028 a separator, and "quotes"';

			expect(await storage.append(awkward)).toEqual({ ok: true, value: { seq: 0 } });
			const long = "x".repeat(100_000);
			expect(await storage.append(long)).toEqual({ ok: true, value: { seq: 1 } });

			const read = await storage.read();
			expect(read.ok).toBe(true);
			if (!read.ok) {
				return;
			}
			expect(read.value).toEqual([awkward, long]);
			// Exactly as saved, byte for byte, which is what the core's decoder needs.
			expect(read.value[0]).toBe(awkward);

			// A line over this adapter's own limit is refused, and the refusal itself
			// saves nothing: no gap in `seq`, no half-written record.
			const small = fresh(64);
			const refused = await small.append("y".repeat(65));
			expect(refused.ok).toBe(false);
			if (!refused.ok) {
				expect(refused.error.code).toBe("bad_request");
			}
			expect(await small.read()).toEqual({ ok: true, value: [] });

			// Exactly at the limit is allowed, because the limit is a ceiling and not a
			// target. (Byte length, not character length: this is ASCII.)
			expect(await small.append("z".repeat(64))).toEqual({ ok: true, value: { seq: 0 } });
		});

		test("STO04 appends issued together get distinct, increasing seq values", async () => {
			const storage = fresh();
			const lines = Array.from({ length: 10 }, (_, index) => `{"n":${index}}`);
			const results = await Promise.all(lines.map((line) => storage.append(line)));

			const seqs = results.map((result) => (result.ok ? result.value.seq : -1));
			expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
			expect(new Set(seqs).size).toBe(10);
			expect(await storage.read()).toEqual({ ok: true, value: lines });
		});
	});
}
