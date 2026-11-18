import { expect, test } from "vitest";

import type { JsonObject } from "./json.js";
import { SchemaDefinitionError, compileSchema, formatErrors, validateValue } from "./schema.js";

/** The rows are in `docs/recipes-and-tools.md`, SCH01 to SCH20. */

function check(schema: JsonObject, value: unknown) {
	return validateValue(compileSchema(schema), value);
}

function errorsOf(schema: JsonObject, value: unknown): string[] {
	const checked = check(schema, value);
	expect(checked.ok).toBe(false);
	return checked.ok ? [] : checked.errors;
}

const person: JsonObject = {
	type: "object",
	properties: {
		name: { type: "string" },
		age: { type: "integer" },
	},
	required: ["name"],
};

test("SCH01 each type accepts its own value", () => {
	const schema: JsonObject = {
		type: "object",
		properties: {
			text: { type: "string" },
			amount: { type: "number" },
			whole: { type: "integer" },
			yes: { type: "boolean" },
			nothing: { type: "null" },
			tags: { type: "array", items: { type: "string" } },
			inner: { type: "object", properties: { k: { type: "string" } }, required: ["k"] },
		},
		required: ["text", "amount", "whole", "yes", "nothing", "tags", "inner"],
	};
	const value = {
		text: "hello",
		amount: 1.5,
		whole: 2,
		yes: true,
		nothing: null,
		tags: ["a", "b"],
		inner: { k: "v" },
	};
	const checked = check(schema, value);
	expect(checked.ok).toBe(true);
	if (checked.ok) {
		expect(checked.value).toEqual(value);
	}
});

test("SCH02 a required property is required, an optional one need not be there", () => {
	expect(check(person, { name: "Ada" }).ok).toBe(true);
	expect(check(person, { name: "Ada", age: 36 }).ok).toBe(true);
	expect(check(person, {}).ok).toBe(false);

	const open: JsonObject = {
		type: "object",
		properties: { a: { type: "string" } },
		additionalProperties: true,
	};
	expect(check(open, { a: "x", extra: 1 }).ok).toBe(true);
});

test("SCH03 enums and arrays", () => {
	const kind: JsonObject = { type: "string", enum: ["bug", "feat"] };
	expect(check(kind, "bug").ok).toBe(true);
	expect(check(kind, "chore").ok).toBe(false);

	const list: JsonObject = {
		type: "array",
		items: { type: "string" },
		minItems: 1,
		maxItems: 2,
	};
	expect(check(list, ["a"]).ok).toBe(true);
	expect(check(list, ["a", "b"]).ok).toBe(true);
	const bad = errorsOf(list, ["a", 2]);
	expect(bad).toEqual(["arguments[1]: expected string, got number"]);
});

test("SCH04 string and number bounds, at the edges", () => {
	const text: JsonObject = { type: "string", minLength: 2, maxLength: 4 };
	expect(check(text, "ab").ok).toBe(true);
	expect(check(text, "abcd").ok).toBe(true);
	expect(errorsOf(text, "a")).toEqual(["arguments: expected at least 2 characters, got 1"]);
	expect(errorsOf(text, "abcde")).toEqual(["arguments: expected at most 4 characters, got 5"]);

	const count: JsonObject = { type: "number", minimum: 1, maximum: 5 };
	expect(check(count, 1).ok).toBe(true);
	expect(check(count, 5).ok).toBe(true);
	expect(errorsOf(count, 0)).toEqual(["arguments: expected at least 1, got 0"]);
	expect(errorsOf(count, 6)).toEqual(["arguments: expected at most 5, got 6"]);
});

test("SCH05 a missing required field is named", () => {
	expect(errorsOf(person, { age: 3 })).toEqual(["arguments.name: required"]);
});

test("SCH06 a value of the wrong type says what was wanted and what came", () => {
	expect(errorsOf(person, { name: 7 })).toEqual(["arguments.name: expected string, got number"]);
	expect(errorsOf(person, { name: ["a"] })).toEqual([
		"arguments.name: expected string, got array",
	]);
	expect(errorsOf(person, { name: { a: 1 } })).toEqual([
		"arguments.name: expected string, got object",
	]);
	expect(errorsOf({ type: "array", items: { type: "string" } }, "no")).toEqual([
		"arguments: expected array, got string",
	]);
});

test("SCH07 an out-of-range number and an enum miss are specific", () => {
	expect(errorsOf({ type: "number", minimum: 3 }, 1)).toEqual([
		"arguments: expected at least 3, got 1",
	]);
	const kind: JsonObject = { type: "string", enum: ["bug", "feat"] };
	expect(errorsOf(kind, "chore")).toEqual([
		'arguments: expected one of "bug", "feat", got "chore"',
	]);
});

test("SCH08 an unknown key is refused and the allowed ones are listed", () => {
	const schema: JsonObject = {
		type: "object",
		properties: { repo: { type: "string" }, text: { type: "string" } },
	};
	expect(errorsOf(schema, { repo: "lyra", extra: 1 })).toEqual([
		"arguments.extra: not allowed (allowed: repo, text)",
	]);
	expect(errorsOf({ type: "object", properties: {} }, { extra: 1 })).toEqual([
		"arguments.extra: not allowed (no arguments are expected)",
	]);
});

test("SCH09 the root is an object when the schema says so", () => {
	const schema: JsonObject = { type: "object", properties: {} };
	for (const value of [null, [], "text", 3, true]) {
		expect(errorsOf(schema, value).length).toBe(1);
	}
	expect(errorsOf(schema, null)).toEqual(["arguments: expected object, got null"]);
	expect(errorsOf({ type: "string" }, { a: 1 })).toEqual([
		"arguments: expected string, got object",
	]);
});

test("SCH10 nesting past the cap is refused, not a stack overflow", () => {
	let value: unknown = "leaf";
	for (let level = 0; level < 40; level += 1) {
		value = [value];
	}
	const deep = errorsOf({ type: "array" }, value);
	expect(deep).toEqual(["arguments: nested deeper than 32 levels"]);
});

test("SCH11 a thousand failures produce ten errors, and the message stops at 2 KiB", () => {
	const properties: Record<string, JsonObject> = {};
	const required: string[] = [];
	for (let index = 0; index < 1000; index += 1) {
		properties[`field${index}`] = { type: "string" };
		required.push(`field${index}`);
	}
	const errors = errorsOf({ type: "object", properties, required }, {});
	expect(errors.length).toBe(10);

	const long = Array.from({ length: 10 }, (_, index) => `${"x".repeat(300)}${index}`);
	const formatted = formatErrors(long);
	expect(formatted.startsWith("invalid arguments: ")).toBe(true);
	expect(formatted.length).toBeLessThanOrEqual(2048);
});

test("SCH12 a schema with an unsupported keyword is refused when it is compiled", () => {
	for (const keyword of ["pattern", "$ref", "oneOf", "maxlength", "const"]) {
		const schema: JsonObject = { type: "string", [keyword]: "x" };
		expect(() => compileSchema(schema)).toThrow(SchemaDefinitionError);
		expect(() => compileSchema(schema)).toThrow(new RegExp(keyword.replace("$", "\\$")));
	}
});

test("SCH13 a long value is refused without being copied into the message", () => {
	const long = "y".repeat(100_000);
	const errors = errorsOf({ type: "string", maxLength: 10 }, long);
	expect(errors).toEqual(["arguments: expected at most 10 characters, got 100000"]);
	expect(errors[0]?.includes("yyy")).toBe(false);
});

test("SCH15 a malformed schema is refused when it is compiled", () => {
	const bad: JsonObject[] = [
		{ type: "date" },
		{ type: "object", properties: [] },
		{ type: "object", properties: {}, required: "name" },
		{ type: "object", properties: {}, required: ["name"] },
		{ type: "string", enum: [] },
		{ type: "string", enum: [1, "a"] },
		{ type: "array", items: [] },
		{ type: "string", minLength: -1 },
		{ type: "number", minimum: 5, maximum: 1 },
		{ type: "object", additionalProperties: "yes" },
		{ type: "string", minimum: 1 },
	];
	for (const schema of bad) {
		expect(() => compileSchema(schema)).toThrow(SchemaDefinitionError);
	}
});

test("SCH16 prototype names are ordinary keys and never reach a prototype", () => {
	const withProto = JSON.parse('{"__proto__": {"polluted": true}}') as JsonObject;
	const errors = errorsOf({ type: "object", properties: {} }, withProto);
	expect(errors).toEqual(["arguments.__proto__: not allowed (no arguments are expected)"]);
	expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();

	const declared: JsonObject = {
		type: "object",
		properties: { constructor: { type: "string" }, ["__proto__"]: { type: "string" } },
		required: ["constructor"],
	};
	expect(() => check(declared, { constructor: "x", ["__proto__"]: "y" })).not.toThrow();
});

test("SCH17 an enum without a type accepts only its members", () => {
	const schema: JsonObject = { enum: [1, "two"] };
	expect(check(schema, 1).ok).toBe(true);
	expect(check(schema, "two").ok).toBe(true);
	expect(check(schema, "three").ok).toBe(false);
	expect(check(schema, 2).ok).toBe(false);
});

test("SCH18 a nested failure says where it is", () => {
	const schema: JsonObject = {
		type: "object",
		properties: {
			cites: { type: "array", items: { type: "string" } },
			project: {
				type: "object",
				properties: { name: { type: "string" } },
				required: ["name"],
			},
		},
	};
	expect(errorsOf(schema, { cites: ["c1", 2], project: {} })).toEqual([
		"arguments.cites[1]: expected string, got number",
		"arguments.project.name: required",
	]);
});

test("SCH19 an integer refuses a fraction", () => {
	expect(check({ type: "integer" }, 2).ok).toBe(true);
	expect(check({ type: "integer" }, 1.5).ok).toBe(false);
	expect(check({ type: "number" }, 1.5).ok).toBe(true);
});

test("SCH20 a schema nested past the cap is refused when it is compiled", () => {
	let schema: JsonObject = { type: "string" };
	for (let level = 0; level < 40; level += 1) {
		schema = { type: "object", properties: { next: schema } };
	}
	expect(() => compileSchema(schema)).toThrow(/32/);
});
