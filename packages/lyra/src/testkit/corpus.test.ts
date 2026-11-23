import fc from "fast-check";
import { expect, test } from "vitest";

import { generate, replay } from "./corpus.testing.js";

/**
 * The corpus harness (issue #41).
 *
 * The point of these cases is that a committed case is replayed exactly, and that
 * a generated failure is printed shrunk: a case written down from a random
 * failure is only worth keeping if it is the smallest one.
 */

const cases = {
	"a-frame-cut-in-two": { text: '{"type":"command"}\n', cuts: [3, 9] },
	"an-empty-line": { text: "\n", cuts: [] },
} as const;

test("CORPUS replay runs every committed case, one at a time", () => {
	const seen: string[] = [];
	replay("reader", cases, (value) => {
		seen.push(value.text);
	});
	expect(seen).toEqual(['{"type":"command"}\n', "\n"]);
});

/**
 * An empty corpus is an error, not a pass. This is the guard the issue asks for:
 * a corpus directory that exists and holds nothing would otherwise turn replay
 * into a test that cannot fail.
 */
test("CORPUS an empty corpus is a failure, not a green replay", () => {
	expect(() => replay("reader", {}, () => {})).toThrow(/no cases/);
});

/** A failure names the case and the target, or nobody can find the file to open. */
test("CORPUS a failing case names itself and its target", () => {
	expect(() =>
		replay("reader", cases, (value) => {
			if (value.text === "\n") {
				throw new Error("the empty line was refused");
			}
		}),
	).toThrow(/reader.*an-empty-line.*empty line was refused/s);
});

test("CORPUS a generated property that never fails reports nothing", () => {
	expect(() =>
		generate(
			"reader",
			fc.integer({ min: 0, max: 10 }),
			(value) => {
				expect(value).toBeLessThanOrEqual(10);
			},
			{ numRuns: 100 },
		),
	).not.toThrow();
});

/**
 * The reported case is the shrunk one. fast-check finds a failure at, say, 40 and
 * shrinks it to the smallest value that still fails; a corpus built from the
 * first failure it happened to try would be a case nobody can read.
 */
test("CORPUS a generated failure reports the smallest case that still fails", () => {
	let message = "";
	try {
		generate(
			"reader",
			fc.integer({ min: 0, max: 100 }),
			(value) => {
				expect(value).toBeLessThanOrEqual(10);
			},
			{ numRuns: 200 },
		);
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	// 11 is the smallest integer above the bound. The case is JSON, so it can be
	// pasted into the corpus file as a new key.
	expect(message).toContain("reader");
	expect(message).toContain("11");
	expect(message).toContain("seed");
});

/** The failure still fails: reporting the case must not swallow it. */
test("CORPUS a generated failure still fails the test", () => {
	expect(() =>
		generate(
			"reader",
			fc.constant("boom"),
			() => {
				throw new Error("the case was refused");
			},
			{ numRuns: 1 },
		),
	).toThrow(/boom/);
});
