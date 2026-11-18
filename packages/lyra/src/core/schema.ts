/**
 * The JSON Schema subset a tool's arguments are checked against
 * (docs/recipes-and-tools.md, SCH01 to SCH20; decision 111).
 *
 * A tool's `parameters` is one piece of data doing three jobs: what the model is
 * shown, what the tool-set hash covers, and what its arguments are checked against.
 * Keeping it plain JSON Schema means there is one source of truth and no library
 * holding a second copy to drift from it.
 *
 * The subset is deliberately small. There is no `pattern`, because a regular
 * expression written by a tool author is a denial-of-service door on hostile
 * input, and no `$ref` or `oneOf`, because a flat schema is enough for tool
 * arguments. A keyword this build does not understand is refused when the schema is
 * compiled, so a tool author hears about it on the first run rather than never.
 *
 * Everything here is a pure function over data. A hostile schema is refused with
 * `SchemaDefinitionError` (a programming error, at definition time), and a hostile
 * value is refused with errors, never an exception: the value comes from a model,
 * so that path is a boundary (decision 21).
 */

import { isJsonValue, isPlainObject, type JsonValue } from "./json.js";
import { canonicalJson } from "./recipe.js";

/** A schema nested deeper than this is a mistake or an attack, not a tool. */
export const MAX_SCHEMA_DEPTH = 32;

/** Arguments nested deeper than this are refused before anything looks at them. */
export const MAX_VALUE_DEPTH = 32;

/** The most errors one refusal lists, so a message stays a message. */
export const MAX_ERRORS = 10;

/** The most characters one formatted refusal may carry. */
export const MAX_MESSAGE_LENGTH = 2048;

export class SchemaDefinitionError extends Error {
	override readonly name = "SchemaDefinitionError";
}

export type SchemaType = "object" | "string" | "number" | "integer" | "boolean" | "array" | "null";

const SCHEMA_TYPES: readonly SchemaType[] = [
	"object",
	"string",
	"number",
	"integer",
	"boolean",
	"array",
	"null",
];

function isSchemaType(value: unknown): value is SchemaType {
	return SCHEMA_TYPES.some((known) => known === value);
}

/** Every keyword this build understands. Anything else is refused. */
const KNOWN_KEYWORDS = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"enum",
	"items",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
]);

/** A compiled schema: validated once, so a run never re-checks its own definition. */
export type CompiledSchema =
	| {
			kind: "string";
			allowed: readonly string[] | undefined;
			minLength: number | undefined;
			maxLength: number | undefined;
	  }
	| {
			kind: "number";
			integer: boolean;
			allowed: readonly number[] | undefined;
			minimum: number | undefined;
			maximum: number | undefined;
	  }
	| { kind: "boolean"; allowed: readonly boolean[] | undefined }
	| { kind: "null" }
	| {
			kind: "array";
			allowed: readonly JsonValue[] | undefined;
			items: CompiledSchema | undefined;
			minItems: number | undefined;
			maxItems: number | undefined;
	  }
	| {
			kind: "object";
			properties: ReadonlyMap<string, CompiledSchema>;
			required: readonly string[];
			additional: boolean;
	  }
	| { kind: "enum"; values: readonly JsonValue[] };

export type Validation<T = JsonValue> = { ok: true; value: T } | { ok: false; errors: string[] };

function definitionError(message: string): never {
	throw new SchemaDefinitionError(message);
}

function hasOwn(value: object, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(value, key);
}

function requireObject(value: unknown, where: string): Record<string, unknown> {
	if (!isPlainObject(value)) {
		definitionError(`${where} is not an object`);
	}
	return value;
}

function optionalCount(
	schema: Record<string, unknown>,
	key: string,
	where: string,
): number | undefined {
	const value = schema[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		definitionError(`${where}.${key} must be a whole number of zero or more`);
	}
	return value;
}

function optionalNumber(
	schema: Record<string, unknown>,
	key: string,
	where: string,
): number | undefined {
	const value = schema[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "number" || !Number.isFinite(value)) {
		definitionError(`${where}.${key} must be a number`);
	}
	return value;
}

function enumValues(
	schema: Record<string, unknown>,
	where: string,
): readonly JsonValue[] | undefined {
	const value = schema["enum"];
	if (value === undefined) {
		return undefined;
	}
	if (!Array.isArray(value) || value.length === 0) {
		definitionError(`${where}.enum must be a non-empty list`);
	}
	for (const [index, member] of value.entries()) {
		if (!isJsonValue(member)) {
			definitionError(`${where}.enum[${index}] is not JSON`);
		}
	}
	return value;
}

function checkBounds(
	lower: number | undefined,
	upper: number | undefined,
	where: string,
	what: string,
): void {
	if (lower !== undefined && upper !== undefined && lower > upper) {
		definitionError(`${where}.${what} is a range that can never match`);
	}
}

/** Every keyword a compiled kind may carry. A keyword on the wrong kind is a mistake. */
function rejectInapplicable(
	schema: Record<string, unknown>,
	where: string,
	allowed: readonly string[],
): void {
	for (const key of Object.keys(schema)) {
		if (!allowed.includes(key)) {
			definitionError(`${where}.${key} does not apply to a ${String(schema["type"])}`);
		}
	}
}

function compileAt(schema: unknown, where: string, depth: number): CompiledSchema {
	if (depth > MAX_SCHEMA_DEPTH) {
		definitionError(`${where} is nested deeper than ${MAX_SCHEMA_DEPTH} levels`);
	}
	const object = requireObject(schema, where);
	for (const key of Object.keys(object)) {
		if (!KNOWN_KEYWORDS.has(key)) {
			definitionError(`${where} uses the unsupported keyword "${key}"`);
		}
	}

	const type = object["type"];
	const values = enumValues(object, where);
	if (type === undefined) {
		if (values === undefined) {
			definitionError(`${where} needs a "type" or an "enum"`);
		}
		rejectInapplicable(object, where, ["enum"]);
		return { kind: "enum", values };
	}
	if (!isSchemaType(type)) {
		definitionError(`${where}.type must be one of ${SCHEMA_TYPES.join(", ")}`);
	}

	switch (type) {
		case "string": {
			rejectInapplicable(object, where, ["type", "enum", "minLength", "maxLength"]);
			const minLength = optionalCount(object, "minLength", where);
			const maxLength = optionalCount(object, "maxLength", where);
			checkBounds(minLength, maxLength, where, "minLength/maxLength");
			const allowed = values === undefined ? undefined : asStrings(values, where);
			return { kind: "string", allowed, minLength, maxLength };
		}
		case "number":
		case "integer": {
			rejectInapplicable(object, where, ["type", "enum", "minimum", "maximum"]);
			const minimum = optionalNumber(object, "minimum", where);
			const maximum = optionalNumber(object, "maximum", where);
			checkBounds(minimum, maximum, where, "minimum/maximum");
			const integer = type === "integer";
			const allowed = values === undefined ? undefined : asNumbers(values, integer, where);
			return { kind: "number", integer, allowed, minimum, maximum };
		}
		case "boolean": {
			rejectInapplicable(object, where, ["type", "enum"]);
			const allowed = values === undefined ? undefined : asBooleans(values, where);
			return { kind: "boolean", allowed };
		}
		case "null": {
			rejectInapplicable(object, where, ["type"]);
			return { kind: "null" };
		}
		case "array": {
			rejectInapplicable(object, where, ["type", "enum", "items", "minItems", "maxItems"]);
			const rawItems = object["items"];
			const items =
				rawItems === undefined
					? undefined
					: compileAt(rawItems, `${where}.items`, depth + 1);
			const minItems = optionalCount(object, "minItems", where);
			const maxItems = optionalCount(object, "maxItems", where);
			checkBounds(minItems, maxItems, where, "minItems/maxItems");
			if (values !== undefined) {
				for (const [index, member] of values.entries()) {
					if (!Array.isArray(member)) {
						definitionError(`${where}.enum[${index}] is not an array`);
					}
				}
			}
			return { kind: "array", allowed: values, items, minItems, maxItems };
		}
		case "object": {
			rejectInapplicable(object, where, [
				"type",
				"properties",
				"required",
				"additionalProperties",
			]);
			if (values !== undefined) {
				definitionError(`${where}.enum is not supported on an object`);
			}
			const rawProperties = object["properties"];
			const properties = new Map<string, CompiledSchema>();
			if (rawProperties !== undefined) {
				const declared = requireObject(rawProperties, `${where}.properties`);
				for (const [name, child] of Object.entries(declared)) {
					properties.set(
						name,
						compileAt(child, `${where}.properties.${name}`, depth + 1),
					);
				}
			}
			const rawRequired = object["required"];
			const required: string[] = [];
			if (rawRequired !== undefined) {
				if (!Array.isArray(rawRequired)) {
					definitionError(`${where}.required must be a list of property names`);
				}
				for (const name of rawRequired) {
					if (typeof name !== "string") {
						definitionError(`${where}.required must be a list of property names`);
					}
					if (!properties.has(name)) {
						definitionError(
							`${where}.required names "${name}", which ${where}.properties does not declare`,
						);
					}
					if (!required.includes(name)) {
						required.push(name);
					}
				}
			}
			const rawAdditional = object["additionalProperties"];
			if (rawAdditional !== undefined && typeof rawAdditional !== "boolean") {
				definitionError(`${where}.additionalProperties must be true or false`);
			}
			return {
				kind: "object",
				properties,
				required,
				additional: rawAdditional === true,
			};
		}
	}
}

function asStrings(values: readonly JsonValue[], where: string): readonly string[] {
	return values.map((value, index) => {
		if (typeof value !== "string") {
			definitionError(`${where}.enum[${index}] is not a string`);
		}
		return value;
	});
}

function asNumbers(
	values: readonly JsonValue[],
	integer: boolean,
	where: string,
): readonly number[] {
	return values.map((value, index) => {
		if (typeof value !== "number" || !Number.isFinite(value)) {
			definitionError(`${where}.enum[${index}] is not a number`);
		}
		if (integer && !Number.isInteger(value)) {
			definitionError(`${where}.enum[${index}] is not a whole number`);
		}
		return value;
	});
}

function asBooleans(values: readonly JsonValue[], where: string): readonly boolean[] {
	return values.map((value, index) => {
		if (typeof value !== "boolean") {
			definitionError(`${where}.enum[${index}] is not a boolean`);
		}
		return value;
	});
}

/** Compile a tool's parameters, or throw the definition error that says what is wrong. */
export function compileSchema(schema: unknown, where = "parameters"): CompiledSchema {
	return compileAt(schema, where, 0);
}

/** How a value is named in a message. A value of the wrong shape is never quoted back. */
function describe(value: unknown): string {
	if (value === null) {
		return "null";
	}
	if (Array.isArray(value)) {
		return "array";
	}
	return typeof value;
}

const MAX_QUOTED = 60;

function quote(value: JsonValue): string {
	const text = JSON.stringify(value) ?? "null";
	return text.length <= MAX_QUOTED ? text : `${text.slice(0, MAX_QUOTED)}...`;
}

function childPath(path: string, key: string): string {
	return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${path}.${key}` : `${path}[${quote(key)}]`;
}

function allowedList(names: readonly string[]): string {
	const shown = names.slice(0, 20).join(", ");
	return shown === names.join(", ") ? shown : `${shown}, ...`;
}

function push(errors: string[], message: string): void {
	if (errors.length < MAX_ERRORS) {
		errors.push(message);
	}
}

function wrongType(errors: string[], path: string, expected: string, value: unknown): void {
	push(errors, `${path}: expected ${expected}, got ${describe(value)}`);
}

function validateAt(schema: CompiledSchema, value: unknown, path: string, errors: string[]): void {
	if (errors.length >= MAX_ERRORS) {
		return;
	}
	switch (schema.kind) {
		case "enum": {
			const match = isJsonValue(value)
				? schema.values.some((member) => canonicalJson(member) === canonicalJson(value))
				: false;
			if (!match) {
				const got = isJsonValue(value) ? quote(value) : describe(value);
				push(
					errors,
					`${path}: expected one of ${schema.values.map(quote).join(", ")}, got ${got}`,
				);
			}
			return;
		}
		case "string": {
			if (typeof value !== "string") {
				return wrongType(errors, path, "string", value);
			}
			if (schema.allowed !== undefined && !schema.allowed.includes(value)) {
				push(
					errors,
					`${path}: expected one of ${schema.allowed.map(quote).join(", ")}, got ${quote(value)}`,
				);
				return;
			}
			if (schema.minLength !== undefined && value.length < schema.minLength) {
				push(
					errors,
					`${path}: expected at least ${schema.minLength} characters, got ${value.length}`,
				);
			}
			if (schema.maxLength !== undefined && value.length > schema.maxLength) {
				push(
					errors,
					`${path}: expected at most ${schema.maxLength} characters, got ${value.length}`,
				);
			}
			return;
		}
		case "number": {
			if (typeof value !== "number" || !Number.isFinite(value)) {
				return wrongType(errors, path, schema.integer ? "integer" : "number", value);
			}
			if (schema.integer && !Number.isInteger(value)) {
				return wrongType(errors, path, "integer", value);
			}
			if (schema.allowed !== undefined && !schema.allowed.includes(value)) {
				push(errors, `${path}: expected one of ${schema.allowed.join(", ")}, got ${value}`);
				return;
			}
			if (schema.minimum !== undefined && value < schema.minimum) {
				push(errors, `${path}: expected at least ${schema.minimum}, got ${value}`);
			}
			if (schema.maximum !== undefined && value > schema.maximum) {
				push(errors, `${path}: expected at most ${schema.maximum}, got ${value}`);
			}
			return;
		}
		case "boolean": {
			if (typeof value !== "boolean") {
				return wrongType(errors, path, "boolean", value);
			}
			if (schema.allowed !== undefined && !schema.allowed.includes(value)) {
				push(errors, `${path}: expected one of ${schema.allowed.join(", ")}, got ${value}`);
			}
			return;
		}
		case "null": {
			if (value !== null) {
				return wrongType(errors, path, "null", value);
			}
			return;
		}
		case "array": {
			if (!Array.isArray(value)) {
				return wrongType(errors, path, "array", value);
			}
			if (schema.allowed !== undefined) {
				const match = schema.allowed.some(
					(member) => canonicalJson(member) === canonicalJson(value),
				);
				if (!match) {
					push(errors, `${path}: not one of the allowed arrays`);
					return;
				}
			}
			if (schema.minItems !== undefined && value.length < schema.minItems) {
				push(
					errors,
					`${path}: expected at least ${schema.minItems} items, got ${value.length}`,
				);
			}
			if (schema.maxItems !== undefined && value.length > schema.maxItems) {
				push(
					errors,
					`${path}: expected at most ${schema.maxItems} items, got ${value.length}`,
				);
			}
			const items = schema.items;
			if (items === undefined) {
				return;
			}
			for (const [index, item] of value.entries()) {
				if (errors.length >= MAX_ERRORS) {
					return;
				}
				validateAt(items, item, `${path}[${index}]`, errors);
			}
			return;
		}
		case "object": {
			if (!isPlainObject(value)) {
				return wrongType(errors, path, "object", value);
			}
			for (const name of schema.required) {
				if (!hasOwn(value, name)) {
					push(errors, `${childPath(path, name)}: required`);
				}
			}
			for (const [name, child] of schema.properties) {
				if (hasOwn(value, name)) {
					validateAt(child, value[name], childPath(path, name), errors);
				}
			}
			if (!schema.additional) {
				const names = [...schema.properties.keys()];
				for (const name of Object.keys(value)) {
					if (!schema.properties.has(name)) {
						push(
							errors,
							`${childPath(path, name)}: not allowed (${
								names.length === 0
									? "no arguments are expected"
									: `allowed: ${allowedList(names)}`
							})`,
						);
					}
				}
			}
		}
	}
}

/** Anything nested past the cap is refused outright, before a schema descends into it. */
function exceedsDepth(value: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
	while (stack.length > 0) {
		const item = stack.pop();
		if (item === undefined) {
			break;
		}
		if (item.depth > MAX_VALUE_DEPTH) {
			return true;
		}
		if (Array.isArray(item.value)) {
			for (const child of item.value) {
				stack.push({ value: child, depth: item.depth + 1 });
			}
		} else if (isPlainObject(item.value)) {
			for (const child of Object.values(item.value)) {
				stack.push({ value: child, depth: item.depth + 1 });
			}
		}
	}
	return false;
}

/** Check a value against a compiled schema. It never throws, whatever the value is. */
export function validateValue<T = JsonValue>(
	schema: CompiledSchema,
	value: unknown,
): Validation<T> {
	if (exceedsDepth(value)) {
		return {
			ok: false,
			errors: [`arguments: nested deeper than ${MAX_VALUE_DEPTH} levels`],
		};
	}
	const errors: string[] = [];
	validateAt(schema, value, "arguments", errors);
	if (errors.length > 0) {
		return { ok: false, errors };
	}
	// The one cast in the validator: everything above has checked the value against
	// the same subset the inferred type describes, so this is a claim, not a guess.
	return { ok: true, value: value as T };
}

/** The message the model reads: stable, specific, and never longer than the cap. */
export function formatErrors(errors: readonly string[]): string {
	const text = `invalid arguments: ${errors.join("; ")}`;
	if (text.length <= MAX_MESSAGE_LENGTH) {
		return text;
	}
	return `${text.slice(0, MAX_MESSAGE_LENGTH - 3)}...`;
}

/**
 * The type `defineTool` infers from a schema written as a literal.
 *
 * It mirrors the subset exactly: an `enum` becomes a union of its values, `required`
 * decides which properties cannot be left out, and a nested object or array is
 * inferred from its own schema. A schema the subset does not understand does not
 * compile in the first place, so there is nothing to fall back to here.
 */
type PropertiesOf<S> = S extends { properties: infer P } ? P : Record<string, never>;

type RequiredOf<S> = S extends { required: readonly (infer R)[] } ? Extract<R, string> : never;

type InferObject<S> = {
	[K in keyof PropertiesOf<S> as K extends RequiredOf<S> ? K : never]: InferSchema<
		PropertiesOf<S>[K]
	>;
} & {
	[K in keyof PropertiesOf<S> as K extends RequiredOf<S> ? never : K]?: InferSchema<
		PropertiesOf<S>[K]
	>;
};

export type InferSchema<S> = S extends { enum: readonly (infer E)[] }
	? E
	: S extends { type: "string" }
		? string
		: S extends { type: "number" }
			? number
			: S extends { type: "integer" }
				? number
				: S extends { type: "boolean" }
					? boolean
					: S extends { type: "null" }
						? null
						: S extends { type: "array"; items: infer I }
							? InferSchema<I>[]
							: S extends { type: "array" }
								? JsonValue[]
								: S extends { type: "object" }
									? InferObject<S>
									: JsonValue;
