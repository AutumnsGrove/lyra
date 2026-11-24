import fc from "fast-check";
import { expect, test } from "vitest";

import { generate } from "../testkit/corpus.testing.js";
import { holds } from "./corpus/reader.testing.js";
import { lineReader } from "./reader.js";

/**
 * FRM03 in `docs/protocol.md`. The frame reader is where a socket's bytes are
 * parsed, and the failure-mode catalog names it as a fuzz target: whatever
 * arrives, in whatever pieces, it returns lines or closes on the cap, never by
 * throwing, hanging or growing past the cap.
 *
 * The committed cases in `corpus/reader.testing.ts` run through the same `holds`
 * as the generator, so the two cannot drift apart (issue #41).
 */

const nasty = fc.oneof(
	fc.string({ maxLength: 300 }),
	fc.array(fc.string({ maxLength: 40 }), { maxLength: 12 }).map((parts) => parts.join("\n")),
	fc.constantFrom(
		"",
		"\n",
		"\r\n",
		"\r",
		"\u2028",
		"\u0000",
		'{"type":"command"}',
		"a".repeat(200),
		"ÿ".repeat(50),
	),
);

test("FRM03 any bytes in any pieces give lines or a refusal, never a throw", () => {
	generate("reader", fc.tuple(nasty, fc.array(fc.nat({ max: 100 }), { maxLength: 10 })), holds, {
		numRuns: 400,
	});
});

test("FRM03 a stream of newlines never produces a frame", () => {
	const reader = lineReader({ maxLineBytes: 8 });
	expect(reader.push(new TextEncoder().encode("\n\n\n\r\n\n")).lines).toEqual([]);
	expect(reader.end().lines).toEqual([]);
});

/**
 * The reader as it was first written, one byte at a time into a plain array. It is
 * slow and obviously right, which is what a reference is for: the real reader is
 * allowed to be faster only while it answers exactly the same.
 */
function referenceRead(
	chunks: readonly Uint8Array[],
	cap: number,
): { lines: string[]; overCap?: { bytes: number; cap: number } } {
	let pending: number[] = [];
	const lines: string[] = [];
	const finish = (bytes: number[]): string => {
		const trimmed =
			bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.slice(0, -1) : bytes;
		return new TextDecoder().decode(Uint8Array.from(trimmed));
	};
	for (const chunk of chunks) {
		for (const byte of chunk) {
			if (byte === 0x0a) {
				const line = finish(pending);
				pending = [];
				if (line !== "") {
					lines.push(line);
				}
				continue;
			}
			pending.push(byte);
			if (pending.length > cap) {
				return { lines, overCap: { bytes: pending.length, cap } };
			}
		}
	}
	const last = finish(pending);
	if (last !== "") {
		lines.push(last);
	}
	return { lines };
}

test("FRM03 the reader answers exactly as the byte-at-a-time reference, in any chunking", () => {
	const bytesOf = fc.uint8Array({ maxLength: 120 });
	fc.assert(
		fc.property(
			bytesOf,
			fc.array(fc.nat({ max: 40 }), { maxLength: 8 }),
			fc.integer({ min: 1, max: 40 }),
			(data, cuts, cap) => {
				const chunks: Uint8Array[] = [];
				let from = 0;
				for (const cut of cuts) {
					chunks.push(data.slice(from, from + cut));
					from += cut;
				}
				chunks.push(data.slice(from));

				const reader = lineReader({ maxLineBytes: cap });
				const lines: string[] = [];
				let overCap: { bytes: number; cap: number } | undefined;
				for (const chunk of chunks) {
					const read = reader.push(chunk);
					lines.push(...read.lines);
					overCap ??= read.overCap;
				}
				const ended = reader.end();
				lines.push(...ended.lines);
				overCap ??= ended.overCap;

				const expected = referenceRead(chunks, cap);
				expect(lines).toEqual(expected.lines);
				expect(overCap).toEqual(expected.overCap);
			},
		),
		{ numRuns: 600 },
	);
});
