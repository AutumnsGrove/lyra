import { expect } from "vitest";

import { lineReader } from "../reader.js";

/**
 * The committed cases for FRM03, and the property they hold, each one a shape that
 * has to stay handled: a frame split mid-line, a multi-byte character split
 * mid-character, a line exactly at the cap and one past it, and the two ends of
 * "nothing at all".
 *
 * The property lives here rather than in the fuzz target so the generator in
 * `reader.fuzz.test.ts` and the replay in `corpus/reader.test.ts` share one
 * definition and cannot drift apart. The replay is a plain `.test.ts` on purpose:
 * `pnpm test` runs it, which is also what the nightly shuffled run repeats
 * (issue #41).
 */

/** `[the bytes as text, where the reader is fed a piece]`, cuts in byte offsets. */
export type ReaderCase = readonly [string, readonly number[]];

export const cases: Readonly<Record<string, ReaderCase>> = {
	"a-frame-split-in-two": ['{"type":"command"}\n', [10]],
	"a-frame-split-at-every-newline": ['{"a":1}\n{"b":2}\n{"c":3}\n', [8, 16]],
	"a-character-split-in-half": ["ÿÿÿ\n", [1, 3, 5]],
	"a-line-exactly-at-the-cap": ["a".repeat(64), []],
	"a-line-one-past-the-cap": ["a".repeat(65), []],
	"a-lone-carriage-return": ["\r", []],
	"nul-bytes-and-nothing-else": ["\u0000\u0000\n", [1]],
	"the-empty-stream": ["", []],
};

/**
 * The property, shared by the generator and the replay: given bytes and where they
 * were cut, the reader returns lines or refuses at the cap, and never throws.
 */
export function holds([text, cuts]: ReaderCase): void {
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
