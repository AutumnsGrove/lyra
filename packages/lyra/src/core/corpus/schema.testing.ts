/**
 * Committed cases for SCH14 (`core/schema.fuzz.test.ts`). A tool's arguments are
 * the model's doing, so they are hostile by default, and a schema is written by a
 * tool author who can be wrong. Each case here is one of those two mistakes: a
 * schema this build must refuse, and a value that must be validated or reported
 * rather than thrown on.
 *
 * They are written here rather than generated so they replay on every gate run
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
	"a-validator-shaped-function-in-the-value": [{ type: "object" }, { f: "() => {}" }],
	"nothing-at-all": [null, null],
};
