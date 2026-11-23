import { expect } from "vitest";

import { SchemaDefinitionError, compileSchema, formatErrors, validateValue } from "../schema.js";

/**
 * The committed cases for SCH14, and the property they hold. A tool's arguments
 * are the model's doing, so they are hostile by default, and a schema is written
 * by a tool author who can be wrong. Each case is one of those two mistakes: a
 * schema this build must refuse, and a value that must be validated or reported
 * rather than thrown on.
 *
 * The property lives here so the generator in `schema.fuzz.test.ts` and the replay
 * in `corpus/schema.test.ts` share one definition. The replay is a plain
 * `.test.ts`, so `pnpm test` and the nightly shuffled run both cover it
 * (issue #41).
 */

/** `[the schema as it arrived, the value to validate]`. */
export type SchemaCase = readonly [unknown, unknown];

export const cases: Readonly<Record<string, SchemaCase>> = {
	"a-required-property-that-is-missing": [
		{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
		{},
	],
	"an-enum-with-no-members": [{ type: "string", enum: [] }, "anything"],
	"a-required-list-that-is-a-string": [{ type: "object", required: "a" }, {}],
	"a-type-this-build-does-not-know": [{ type: "date" }, "2026-01-01"],
	"a-prototype-key-in-the-properties": [
		{ type: "object", properties: { ["__proto__"]: { type: "string" } } },
		{ ["__proto__"]: { polluted: true } },
	],
	"arrays-nested-past-the-cap": [
		{ type: "array", items: { type: "array", items: { type: "array" } } },
		[[[1]]],
	],
	"a-schema-that-is-not-an-object": ["not a schema", null],
	"a-value-of-the-wrong-type": [{ type: "number", minimum: 1 }, "one"],
	// A real function, not a string that looks like one: the property asserts that an
	// accepted value is never a function, and a string would not exercise that.
	"a-function-as-the-value": [{ type: "object" }, () => {}],
	"nothing-at-all": [null, null],
};

/** The property: a schema compiles or is refused, and a value validates or reports. */
export function holds([schema, value]: SchemaCase): void {
	let compiled;
	try {
		compiled = compileSchema(schema);
	} catch (error) {
		expect(error).toBeInstanceOf(SchemaDefinitionError);
		return;
	}
	const result = validateValue(compiled, value);
	if (result.ok) {
		// An accepted value is JSON, because the validator only ever passes on
		// numbers, strings, booleans, null, arrays and objects.
		expect(typeof result.value).not.toBe("function");
		return;
	}
	expect(result.errors.length).toBeGreaterThan(0);
	expect(result.errors.length).toBeLessThanOrEqual(10);
	expect(formatErrors(result.errors).length).toBeLessThanOrEqual(2048);
}
