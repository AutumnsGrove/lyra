import { expect, test } from "vitest";

import { DEFAULT_LINE_CAP_BYTES, lineReader } from "./reader.js";

/**
 * The streaming line reader (docs/protocol.md, FRM01 and FRM03). What arrives is
 * bytes in some arbitrary framing; what a session needs is lines. The cases here
 * are the ways a network splits one.
 */

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

function readAll(chunks: readonly string[], options = {}): string[] {
	const reader = lineReader(options);
	const lines: string[] = [];
	for (const chunk of chunks) {
		const read = reader.push(bytes(chunk));
		lines.push(...read.lines);
	}
	lines.push(...reader.end().lines);
	return lines;
}

test("FRM03 several lines in one chunk all come out", () => {
	expect(readAll(['{"a":1}\n{"b":2}\n{"c":3}\n'])).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
});

test("FRM03 a line split across chunks is joined", () => {
	expect(readAll(['{"a":', '"b"}', "\n"])).toEqual(['{"a":"b"}']);
	// And one byte at a time, which is the worst a network can do.
	expect(readAll([...'{"a":"b"}\n'])).toEqual(['{"a":"b"}']);
});

test("FRM03 CRLF is a line ending and empty lines are skipped", () => {
	expect(readAll(['{"a":1}\r\n', "\n", '{"b":2}\r\n'])).toEqual(['{"a":1}', '{"b":2}']);
	// A carriage return that is not followed by a newline is part of the text.
	expect(readAll(['{"a":"x\ry"}\n'])[0]).toContain("\r");
});

test("FRM03 a multi-byte character split across chunks decodes once", () => {
	const whole = bytes('{"t":"héllo ✓"}\n');
	const cut = 8;
	const reader = lineReader();
	const first = reader.push(whole.slice(0, cut));
	const second = reader.push(whole.slice(cut));
	expect(first.lines).toEqual([]);
	expect(second.lines).toEqual(['{"t":"héllo ✓"}']);
});

test("FRM03 a U+2028 inside a string is text, not a line ending", () => {
	const line = JSON.stringify({ text: "one\u2028two" });
	expect(readAll([`${line}\n`])).toEqual([line]);
});

test("FRM03 a last line without a newline is still a line", () => {
	expect(readAll(['{"a":1}\n{"b":2}'])).toEqual(['{"a":1}', '{"b":2}']);
	expect(readAll(['{"a":1}\n'])).toEqual(['{"a":1}']);
});

test("FRM01 a line at the cap is fine and one byte past it closes the connection", () => {
	const atCap = lineReader({ maxLineBytes: 10 });
	expect(atCap.push(bytes(`${"a".repeat(10)}\n`)).lines).toEqual(["a".repeat(10)]);

	const reader = lineReader({ maxLineBytes: 10 });
	const read = reader.push(bytes(`${"a".repeat(11)}\n`));
	expect(read.lines).toEqual([]);
	expect(read.overCap).toEqual({ bytes: 11, cap: 10 });
	// Nothing more is assembled: the connection is closed, so further bytes are not
	// a frame anybody should act on.
	expect(reader.push(bytes('{"a":1}\n')).lines).toEqual([]);
	expect(reader.end().lines).toEqual([]);
});

test("FRM01 the default cap leaves room for a contract's 2 MiB", () => {
	expect(DEFAULT_LINE_CAP_BYTES).toBe(2 * 1024 * 1024);
});
