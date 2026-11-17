/**
 * The record's entries: their types, and the one place they are written and read
 * (docs/run-record.md, decision 31).
 *
 * The core owns this format. Everything that saves a record saves these lines,
 * and everything that reads one comes back through `load.ts`, so the shape is
 * validated in a single place and an adapter never has to know what an entry is.
 *
 * Encoding is deterministic: the fields go out in a fixed order, so the same run
 * produces the same bytes and a test can compare two records directly.
 */

import { decodeFinishReason, decodeUsage } from "../core/decode-reply.js";
import { isJsonValue, isPlainObject } from "../core/json.js";
import type { JsonValue } from "../core/json.js";
import type { FinishReason, ToolCall, Usage } from "../core/model.js";
import { fail, ok, type Result } from "../core/result.js";

/** The format this code writes. A record of any other version is refused, not guessed at. */
export const RECORD_VERSION = 1;

/** What a run started with, so a resume after a deploy can check it (decision 91). */
export interface RecipeStamp {
	name: string;
	version: number;
	toolSetHash: string;
}

export interface RecordHeader {
	type: "header";
	v: number;
	run: string;
	task: string;
	startedAt: number;
	host: string;
	recipe?: RecipeStamp;
}

/** Every entry carries its own id and the id of the entry before it (decision 30). */
interface EntryBase {
	id: string;
	parent: string | null;
	ts: number;
}

export type MessageLabel = "task" | "steer" | "follow_up" | "reminder";

/** What was cut to keep an entry under the cap, and how much (decision 90). */
export interface Truncation {
	field: "content" | "details" | "text" | "reasoning" | "arguments";
	droppedBytes: number;
}

export interface UserMessageEntry extends EntryBase {
	type: "user_message";
	label: MessageLabel;
	text: string;
}

export interface AssistantMessageEntry extends EntryBase {
	type: "assistant_message";
	text: string;
	reasoning?: string;
	toolCalls: ToolCall[];
	model: string;
	usage: Usage;
	finishReason: FinishReason;
	/** Set when this entry was cut to fit the cap; the text carries the marker too. */
	truncated?: Truncation;
}

export interface ToolMessageEntry extends EntryBase {
	type: "tool_message";
	toolCallId: string;
	isError: boolean;
	content: string;
	/** For a person reading the record, never for the model. */
	details?: JsonValue;
	/** Set when this entry was cut to fit the cap; the content carries the marker too. */
	truncated?: Truncation;
}

export type RunState = "running" | "parked" | "done" | "failed" | "resumed";

export interface StatusEntry extends EntryBase {
	type: "status";
	state: RunState;
	/** Why it parked: `stopped`, `stuck`, and the reasons later steps add. */
	reason?: string;
}

/**
 * A kind this version does not know, kept exactly as it was saved, so a record
 * written by a newer Lyra survives a reader that is older and is not rewritten
 * into something smaller. Replay skips it.
 */
export interface UnknownEntry extends EntryBase {
	type: "unknown";
	raw: string;
}

export type RecordEntry =
	UserMessageEntry | AssistantMessageEntry | ToolMessageEntry | StatusEntry | UnknownEntry;

/** Narrowing by hand, because `Array.includes` keeps the argument as `unknown`. */
function isLabel(value: unknown): value is MessageLabel {
	return value === "task" || value === "steer" || value === "follow_up";
}

function isState(value: unknown): value is RunState {
	return (
		value === "running" ||
		value === "parked" ||
		value === "done" ||
		value === "failed" ||
		value === "resumed"
	);
}

export function encodeHeader(header: RecordHeader): string {
	const line: Record<string, unknown> = {
		type: "header",
		v: header.v,
		run: header.run,
		task: header.task,
		startedAt: header.startedAt,
		host: header.host,
	};
	if (header.recipe !== undefined) {
		line["recipe"] = {
			name: header.recipe.name,
			version: header.recipe.version,
			toolSetHash: header.recipe.toolSetHash,
		};
	}
	return JSON.stringify(line);
}

export function encodeEntry(entry: RecordEntry): string {
	const base = { id: entry.id, parent: entry.parent, ts: entry.ts };
	switch (entry.type) {
		case "user_message":
			return JSON.stringify({
				type: entry.type,
				...base,
				label: entry.label,
				text: entry.text,
			});
		case "assistant_message": {
			const line: Record<string, unknown> = {
				type: entry.type,
				...base,
				text: entry.text,
				toolCalls: entry.toolCalls.map((call) => ({
					id: call.id,
					name: call.name,
					arguments: call.arguments,
				})),
				model: entry.model,
				usage: entry.usage,
				finishReason: entry.finishReason,
			};
			if (entry.reasoning !== undefined) {
				line["reasoning"] = entry.reasoning;
			}
			if (entry.truncated !== undefined) {
				line["truncated"] = entry.truncated;
			}
			return JSON.stringify(line);
		}
		case "tool_message": {
			const line: Record<string, unknown> = {
				type: entry.type,
				...base,
				toolCallId: entry.toolCallId,
				isError: entry.isError,
				content: entry.content,
			};
			if (entry.details !== undefined) {
				line["details"] = entry.details;
			}
			if (entry.truncated !== undefined) {
				line["truncated"] = entry.truncated;
			}
			return JSON.stringify(line);
		}
		case "status": {
			const line: Record<string, unknown> = { type: entry.type, ...base, state: entry.state };
			if (entry.reason !== undefined) {
				line["reason"] = entry.reason;
			}
			return JSON.stringify(line);
		}
		case "unknown":
			return entry.raw;
	}
}

/**
 * The tool calls of a saved assistant turn, read tolerantly.
 *
 * `decodeReply` is strict about a call's id and name because it guards an
 * adapter, where an empty one is a bug. The record is different: it preserves
 * what the model said, including a call the loop then refused to run, so its
 * reader accepts empty names, empty ids and repeated ids. Dropping the turn would
 * lose the history the record exists to keep, and would leave the results that
 * follow it unpaired (found by LOOP12).
 */
function decodeStoredToolCalls(value: unknown): Result<ToolCall[]> {
	if (value === undefined) {
		return ok([]);
	}
	if (!Array.isArray(value)) {
		return bad("an assistant_message entry has tool calls that are not a list");
	}
	const calls: ToolCall[] = [];
	for (const [index, call] of value.entries()) {
		if (!isPlainObject(call)) {
			return bad(
				`an assistant_message entry has a toolCalls[${index}] that is not an object`,
			);
		}
		const id = call["id"];
		const name = call["name"];
		const args = call["arguments"];
		if (typeof id !== "string" || typeof name !== "string" || typeof args !== "string") {
			return bad(
				`an assistant_message entry has a toolCalls[${index}] that is not an id, a name and its arguments`,
			);
		}
		calls.push({ id, name, arguments: args });
	}
	return ok(calls);
}

function bad(problem: string): Result<never> {
	return fail("bad_request", problem);
}

const TRUNCATED_FIELDS: readonly Truncation["field"][] = [
	"content",
	"details",
	"text",
	"reasoning",
	"arguments",
];

function isTruncatedField(value: unknown): value is Truncation["field"] {
	return TRUNCATED_FIELDS.some((known) => known === value);
}

function decodeTruncation(value: unknown): Result<Truncation | undefined> {
	if (value === undefined) {
		return ok(undefined);
	}
	if (!isPlainObject(value)) {
		return bad("an entry has a truncated marker that is not an object");
	}
	const field = value["field"];
	const droppedBytes = value["droppedBytes"];
	if (!isTruncatedField(field)) {
		return bad("an entry has a truncated marker naming a field this build does not know");
	}
	if (!isTimestamp(droppedBytes) || droppedBytes === 0) {
		return bad("an entry has a truncated marker without a count of bytes dropped");
	}
	return ok({ field, droppedBytes });
}

function isTimestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isName(value: unknown): value is string {
	return typeof value === "string" && value !== "";
}

export function decodeHeader(value: unknown): Result<RecordHeader> {
	if (!isPlainObject(value) || value["type"] !== "header") {
		return bad("the first line of a record is not a header");
	}
	if (value["v"] !== RECORD_VERSION) {
		return bad("the record's version is not one this build understands");
	}
	const run = value["run"];
	const task = value["task"];
	const startedAt = value["startedAt"];
	const host = value["host"];
	if (!isName(run)) {
		return bad("the record header has no run id");
	}
	if (typeof task !== "string") {
		return bad("the record header has no task name");
	}
	if (!isTimestamp(startedAt)) {
		return bad("the record header has no start time");
	}
	if (typeof host !== "string") {
		return bad("the record header has no host");
	}

	const rawRecipe = value["recipe"];
	if (rawRecipe === undefined) {
		return ok({ type: "header", v: RECORD_VERSION, run, task, startedAt, host });
	}
	if (!isPlainObject(rawRecipe)) {
		return bad("the record header's recipe is not an object");
	}
	const name = rawRecipe["name"];
	const version = rawRecipe["version"];
	const toolSetHash = rawRecipe["toolSetHash"];
	if (typeof name !== "string" || !isTimestamp(version) || !isName(toolSetHash)) {
		return bad("the record header's recipe is not a name, a version and a tool-set hash");
	}
	return ok({
		type: "header",
		v: RECORD_VERSION,
		run,
		task,
		startedAt,
		host,
		recipe: { name, version, toolSetHash },
	});
}

/**
 * One entry, from a parsed line. `raw` is the line as saved, kept only when the
 * kind is one this build does not know, so it can be written back unchanged.
 */
export function decodeEntry(value: unknown, raw: string): Result<RecordEntry> {
	if (!isPlainObject(value)) {
		return bad("an entry is not a JSON object");
	}
	const type = value["type"];
	if (!isName(type)) {
		return bad("an entry has no type");
	}
	const id = value["id"];
	const parent = value["parent"];
	const ts = value["ts"];
	if (!isName(id)) {
		return bad(`a ${type} entry has no id`);
	}
	if (parent !== null && !isName(parent)) {
		return bad(`a ${type} entry has no parent`);
	}
	if (!isTimestamp(ts)) {
		return bad(`a ${type} entry has no time`);
	}
	const base = { id, parent, ts };

	switch (type) {
		case "user_message": {
			const label = value["label"];
			const text = value["text"];
			if (!isLabel(label)) {
				return bad("a user_message entry has no known label");
			}
			if (typeof text !== "string") {
				return bad("a user_message entry has no text");
			}
			return ok({ type, ...base, label, text });
		}
		case "assistant_message": {
			const text = value["text"];
			const reasoning = value["reasoning"];
			const model = value["model"];
			if (typeof text !== "string") {
				return bad("an assistant_message entry has no text");
			}
			if (reasoning !== undefined && typeof reasoning !== "string") {
				return bad("an assistant_message entry has a reasoning that is not text");
			}
			if (typeof model !== "string") {
				return bad("an assistant_message entry has no model");
			}
			const usage = decodeUsage(value["usage"]);
			if (!usage.ok) {
				return usage;
			}
			const toolCalls = decodeStoredToolCalls(value["toolCalls"]);
			if (!toolCalls.ok) {
				return toolCalls;
			}
			const finishReason = decodeFinishReason(value["finishReason"]);
			const truncation = decodeTruncation(value["truncated"]);
			if (!truncation.ok) {
				return truncation;
			}
			const entry: AssistantMessageEntry = {
				type,
				...base,
				text,
				toolCalls: toolCalls.value,
				model,
				usage: usage.value,
				finishReason,
			};
			if (reasoning !== undefined) {
				entry.reasoning = reasoning;
			}
			if (truncation.value !== undefined) {
				entry.truncated = truncation.value;
			}
			return ok(entry);
		}
		case "tool_message": {
			const toolCallId = value["toolCallId"];
			const isError = value["isError"];
			const content = value["content"];
			const details = value["details"];
			if (!isName(toolCallId)) {
				return bad("a tool_message entry has no tool call id");
			}
			if (typeof isError !== "boolean") {
				return bad("a tool_message entry does not say whether it is an error");
			}
			if (typeof content !== "string") {
				return bad("a tool_message entry has no content");
			}
			const truncation = decodeTruncation(value["truncated"]);
			if (!truncation.ok) {
				return truncation;
			}
			const entry: ToolMessageEntry = { type, ...base, toolCallId, isError, content };
			if (details !== undefined) {
				if (!isJsonValue(details)) {
					return bad("a tool_message entry has details that are not JSON");
				}
				entry.details = details;
			}
			if (truncation.value !== undefined) {
				entry.truncated = truncation.value;
			}
			return ok(entry);
		}
		case "status": {
			const state = value["state"];
			const reason = value["reason"];
			if (!isState(state)) {
				return bad("a status entry has a state this build does not know");
			}
			if (reason !== undefined && !isName(reason)) {
				return bad("a status entry has a reason that is not text");
			}
			return ok(
				reason === undefined ? { type, ...base, state } : { type, ...base, state, reason },
			);
		}
		default:
			return ok({ type: "unknown", ...base, raw });
	}
}
