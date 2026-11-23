import fc from "fast-check";
import { expect, test } from "vitest";

import { generate } from "../testkit/corpus.testing.js";
import { holds } from "./corpus/schema.testing.js";

/**
 * SCH14 in `docs/recipes-and-tools.md`. A tool's arguments are the model's doing,
 * so they are hostile by default, and a schema is written by a tool author who can
 * be wrong. The rule is blunt: a schema is compiled or refused with
 * `SchemaDefinitionError`, and a compiled one validates or reports errors, never
 * throws and never runs past its caps.
 */

/** Schema-shaped values, including the keywords this build must refuse. */
const schemaish = fc.oneof(
	fc.jsonValue(),
	fc.constantFrom(
		{},
		{ type: "object" },
		{ type: "object", properties: {}, required: [] },
		{ type: "string", enum: [] },
		{ type: "array", items: { type: "string" } },
		{ type: "string", pattern: "^a+$" },
		{ oneOf: [{ type: "string" }, { type: "number" }] },
		{ type: "array", items: { type: "array", items: { type: "array" } } },
		{ type: "object", properties: { ["__proto__"]: { type: "string" } } },
		fc.record({
			type: fc.constantFrom(
				"object",
				"array",
				"string",
				"number",
				"integer",
				"boolean",
				"null",
				"date",
			),
			properties: fc.dictionary(fc.string(), fc.anything()),
			required: fc.oneof(fc.array(fc.string(), { maxLength: 3 }), fc.string()),
		}),
	),
);

const values = fc.oneof(
	fc.jsonValue(),
	fc.constantFrom(null, [], {}, "text", 0, 1.5, true, { ["__proto__"]: { polluted: true } }),
);

test("SCH14 any schema and any value compile or are refused without throwing", () => {
	generate("schema", fc.tuple(schemaish, values), holds, { numRuns: 500 });
});
