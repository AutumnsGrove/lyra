/**
 * JSON as plain data.
 *
 * Tool arguments, tool specs and record details all cross a boundary as JSON,
 * so they are typed as JSON rather than as `unknown` or `any`. A value that is
 * not JSON cannot be declared, and the decoders in the modules that take
 * outside data check the shape again at the edge.
 */

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}

/**
 * A plain object, told apart from `null`, a list and a primitive. This is the
 * first check every decoder makes, so it lives beside the type it narrows to.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A JSON value, checked all the way down. A tool's `details` is the only place
 * outside data can be any shape, and it is stored in the record, so it has to be
 * something that can be written back out. The depth cap keeps a hand-written or
 * hostile document from recursing further than the decoder's own stack.
 */
const MAX_JSON_DEPTH = 64;

export function isJsonValue(value: unknown, depth = 0): value is JsonValue {
	if (depth > MAX_JSON_DEPTH) {
		return false;
	}
	if (value === null || typeof value === "string" || typeof value === "boolean") {
		return true;
	}
	if (typeof value === "number") {
		return Number.isFinite(value);
	}
	if (Array.isArray(value)) {
		return value.every((item) => isJsonValue(item, depth + 1));
	}
	if (isPlainObject(value)) {
		return Object.values(value).every((item) => isJsonValue(item, depth + 1));
	}
	return false;
}
