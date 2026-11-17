import { expect, test } from "vitest";

import { isJsonValue, isPlainObject } from "./json.js";

/**
 * The guard behind a tool's `details`, which is the one place outside data can
 * be any shape and still has to be writable into the record. It has no spec row
 * of its own: the loader's RCD04 is where it is used, and this is the unit-level
 * statement of what it accepts.
 */

test("a JSON document is accepted, all the way down", () => {
	expect(isJsonValue({ a: [1, "two", null, { b: true }] })).toBe(true);
	expect(isJsonValue([])).toBe(true);
	expect(isJsonValue("")).toBe(true);
	expect(isJsonValue(0)).toBe(true);
});

test("a value JSON cannot write is refused", () => {
	for (const value of [undefined, () => 1, Number.NaN, Number.POSITIVE_INFINITY]) {
		expect(isJsonValue(value)).toBe(false);
	}
});

test("a document nested further than the cap is refused, so nothing recurses without a bound", () => {
	let value: unknown = "bottom";
	for (let level = 0; level < 65; level += 1) {
		value = [value];
	}
	expect(isJsonValue(value)).toBe(false);
});

test("a plain object is told apart from null, a list and a primitive", () => {
	expect(isPlainObject({})).toBe(true);
	for (const value of [null, [], "text", 7, undefined]) {
		expect(isPlainObject(value)).toBe(false);
	}
});
