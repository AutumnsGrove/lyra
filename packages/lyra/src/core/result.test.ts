import { expect, test } from "vitest";

import { err, fail, ok } from "./result.js";

/**
 * The three halves of a `Result`. There is no spec row for these: they are the
 * vocabulary the rows are written in, so what matters is that the discriminator
 * is the one the types promise, which is what a consumer narrows on.
 */

test("ok carries a value and is discriminated by ok", () => {
	const result = ok(7);
	expect(result.ok).toBe(true);
	expect(result).toHaveProperty("value", 7);
	expect(result).not.toHaveProperty("error");
});

test("err carries an error and is discriminated by ok", () => {
	const result = err({ code: "internal", message: "boom" });
	expect(result.ok).toBe(false);
	expect(result).toHaveProperty("error", { code: "internal", message: "boom" });
});

test("fail builds the common shape, with the code a caller switches on", () => {
	const result = fail("bad_request", "the reply is not an object");
	expect(result.ok).toBe(false);
	expect(result).toHaveProperty("error.code", "bad_request");
	expect(result).toHaveProperty("error.message", "the reply is not an object");
});
