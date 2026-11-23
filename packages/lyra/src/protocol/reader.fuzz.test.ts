import fc from "fast-check";
import { expect, test } from "vitest";

import { generate, replay } from "../testkit/corpus.testing.js";
import { cases, type ReaderCase } from "./corpus/reader.testing.js";
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

/** The property, independent of where the bytes came from. */
function holds([text, cuts]: ReaderCase): void {
	const bytes = new TextEncoder().encode(text);
	const reader = lineReader({ maxLineBytes: 64 });
	const lines: string[] = [];
	let position = 0;
	let overCap = false;
	for (const cut of [...cuts].sort((a, b) => a - b)) {
		if (position >= bytes.length || overCap) {
			break;
		}
		const at = Math.max(position, Math.min(cut, bytes.length));
		const read = reader.push(bytes.slice(position, at));
		position = at;
		lines.push(...read.lines);
		overCap = read.overCap !== undefined;
	}
	if (!overCap && position < bytes.length) {
		lines.push(...reader.push(bytes.slice(position)).lines);
	}
	lines.push(...reader.end().lines);
	for (const line of lines) {
		expect(typeof line).toBe("string");
		expect(line).not.toBe("");
		// A line always comes from the bytes that were fed, never from nothing.
		expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(
			Math.max(64, bytes.length),
		);
	}
}

test("FRM03 any bytes in any pieces give lines or a refusal, never a throw", () => {
	generate("reader", fc.tuple(nasty, fc.array(fc.nat({ max: 100 }), { maxLength: 10 })), holds, {
		numRuns: 400,
	});
});

test("FRM03 the committed cases still hold", () => {
	replay("reader", cases, holds);
});

test("FRM03 a stream of newlines never produces a frame", () => {
	const reader = lineReader({ maxLineBytes: 8 });
	expect(reader.push(new TextEncoder().encode("\n\n\n\r\n\n")).lines).toEqual([]);
	expect(reader.end().lines).toEqual([]);
});
