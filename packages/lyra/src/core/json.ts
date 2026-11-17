/**
 * JSON as plain data.
 *
 * Tool arguments, tool specs and record details all cross a boundary as JSON,
 * so they are typed as JSON rather than as `unknown` or `any`. A value that is
 * not JSON cannot be declared, and the decoders in the modules that take
 * outside data check the shape again at the edge.
 */

export type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

export interface JsonObject {
	[key: string]: JsonValue;
}
