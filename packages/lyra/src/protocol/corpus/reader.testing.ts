/**
 * Committed cases for FRM03 (`protocol/reader.fuzz.test.ts`), each one a shape
 * that has to stay handled: a frame split mid-line, a multi-byte character split
 * mid-character, a line exactly at the cap and one past it, and the two ends of
 * "nothing at all".
 *
 * They are written here rather than generated so they replay on every gate run,
 * whether or not the generator happens to visit them again (issue #41).
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
