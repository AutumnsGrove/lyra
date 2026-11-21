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

/** One tool as the header pinned it: its name, and the hash of its name and arguments. */
export interface ToolStamp {
	name: string;
	hash: string;
}

/** What a run started with, so a resume after a deploy can check it (decision 91). */
export interface RecipeStamp {
	name: string;
	version: number;
	toolSetHash: string;
	/** Added in step 2 (REC06): a reworded prompt alone does not stop a run. */
	instructionsHash?: string;
	/** Added in step 2: one hash per tool, so a change can name the tools it touched. */
	tools?: readonly ToolStamp[];
}

export interface RecordHeader {
	type: "header";
	v: number;
	run: string;
	task: string;
	startedAt: number;
	host: string;
	/**
	 * Whose session this is (decision 47). Absent on a record written before the
	 * protocol existed, which is why a load does not insist on it; the session host
	 * is what refuses a caller of another tenant.
	 */
	tenant?: string;
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
	/**
	 * The task's input as JSON, saved only on the `task` message, so a resume can run
	 * the recipe's `setup` again and rebuild the state it made (decision 112).
	 */
	details?: JsonValue;
}

export interface AssistantMessageEntry extends EntryBase {
	type: "assistant_message";
	text: string;
	reasoning?: string;
	toolCalls: ToolCall[];
	model: string;
	usage: Usage;
	finishReason: FinishReason;
	/** How many times this turn was tried again after a retryable model failure (decision 26). */
	retries?: number;
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
	/**
	 * The done-check passed on this call (decision 25). The record keeps it so a
	 * resume after a kill can tell an accepted finish from any other result, instead
	 * of asking the model for a turn it already gave.
	 */
	done?: true;
	/** Set when this entry was cut to fit the cap; the content carries the marker too. */
	truncated?: Truncation;
}

export type RunState = "running" | "parked" | "done" | "failed" | "resumed";

export interface StatusEntry extends EntryBase {
	type: "status";
	state: RunState;
	/** Why it parked: `stopped`, `stuck`, and the reasons later steps add. */
	reason?: string;
	/** Which part of that reason: a limit's `steps`, `tokens`, `time` or `cost`. */
	detail?: string;
}

/**
 * The recipe moved while the run was alive (REC06, REC09): a new version, reworded
 * instructions, or a tool set a person let it continue with. The new pin becomes
 * the one the next resume compares against.
 */
export interface RecipeUpdatedEntry extends EntryBase {
	type: "recipe_updated";
	/** Absent when the record had no pin at all, which is what a newer Lyra adds. */
	from?: RecipeStamp;
	to: RecipeStamp;
}

/**
 * The run moved to another model because the first failed after its retries
 * (decision 58). Written where it happened, so the record says which model made
 * which turn.
 */
export interface FallbackEntry extends EntryBase {
	type: "fallback";
	from: string;
	to: string;
	reason: string;
}

/**
 * Something worth saying that is not a turn, such as a limit the run cannot
 * enforce (LIM05). `kind` says what it is, so a reader skips one it does not know
 * and a later note does not need a format change.
 */
export interface NoteEntry extends EntryBase {
	type: "note";
	kind: string;
	text: string;
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
	| UserMessageEntry
	| AssistantMessageEntry
	| ToolMessageEntry
	| StatusEntry
	| FallbackEntry
	| RecipeUpdatedEntry
	| NoteEntry
	| UnknownEntry;

/** Narrowing by hand, because `Array.includes` keeps the argument as `unknown`. */
function isLabel(value: unknown): value is MessageLabel {
	return value === "task" || value === "steer" || value === "follow_up" || value === "reminder";
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

/** One pin, as a line's field. Shared by the header and by a `recipe_updated` entry. */
function stampLine(stamp: RecipeStamp): Record<string, unknown> {
	const line: Record<string, unknown> = {
		name: stamp.name,
		version: stamp.version,
		toolSetHash: stamp.toolSetHash,
	};
	if (stamp.instructionsHash !== undefined) {
		line["instructionsHash"] = stamp.instructionsHash;
	}
	if (stamp.tools !== undefined) {
		line["tools"] = stamp.tools.map((tool) => ({ name: tool.name, hash: tool.hash }));
	}
	return line;
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
	if (header.tenant !== undefined) {
		line["tenant"] = header.tenant;
	}
	if (header.recipe !== undefined) {
		line["recipe"] = stampLine(header.recipe);
	}
	return JSON.stringify(line);
}

export function encodeEntry(entry: RecordEntry): string {
	const base = { id: entry.id, parent: entry.parent, ts: entry.ts };
	switch (entry.type) {
		case "user_message": {
			const line: Record<string, unknown> = {
				type: entry.type,
				...base,
				label: entry.label,
				text: entry.text,
			};
			if (entry.details !== undefined) {
				line["details"] = entry.details;
			}
			return JSON.stringify(line);
		}
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
			if (entry.retries !== undefined) {
				line["retries"] = entry.retries;
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
			if (entry.done === true) {
				line["done"] = true;
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
			if (entry.detail !== undefined) {
				line["detail"] = entry.detail;
			}
			return JSON.stringify(line);
		}
		case "note":
			return JSON.stringify({
				type: entry.type,
				...base,
				kind: entry.kind,
				text: entry.text,
			});
		case "fallback":
			return JSON.stringify({
				type: entry.type,
				...base,
				from: entry.from,
				to: entry.to,
				reason: entry.reason,
			});
		case "recipe_updated":
			return JSON.stringify({
				type: entry.type,
				...base,
				...(entry.from === undefined ? {} : { from: stampLine(entry.from) }),
				to: stampLine(entry.to),
			});
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

	const tenant = value["tenant"];
	if (tenant !== undefined && !isName(tenant)) {
		return bad("the record header's tenant is not a name");
	}
	const fields = {
		type: "header" as const,
		v: RECORD_VERSION,
		run,
		task,
		startedAt,
		host,
		...(tenant === undefined ? {} : { tenant }),
	};

	const rawRecipe = value["recipe"];
	if (rawRecipe === undefined) {
		return ok(fields);
	}
	const recipe = decodeStamp(rawRecipe);
	if (!recipe.ok) {
		return recipe;
	}
	return ok({ ...fields, recipe: recipe.value });
}

/** A recipe's pin, from a header or from a `recipe_updated` entry. */
function decodeStamp(value: unknown): Result<RecipeStamp> {
	if (!isPlainObject(value)) {
		return bad("a recipe pin is not an object");
	}
	const name = value["name"];
	const version = value["version"];
	const toolSetHash = value["toolSetHash"];
	if (typeof name !== "string" || !isTimestamp(version) || !isName(toolSetHash)) {
		return bad("a recipe pin is not a name, a version and a tool-set hash");
	}
	const instructionsHash = value["instructionsHash"];
	if (instructionsHash !== undefined && !isName(instructionsHash)) {
		return bad("a recipe pin has an instructions hash that is not text");
	}
	const rawTools = value["tools"];
	let tools: ToolStamp[] | undefined;
	if (rawTools !== undefined) {
		if (!Array.isArray(rawTools)) {
			return bad("a recipe pin has a tool list that is not a list");
		}
		tools = [];
		for (const rawTool of rawTools) {
			if (!isPlainObject(rawTool)) {
				return bad("a recipe pin has a tool that is not an object");
			}
			const toolName = rawTool["name"];
			const toolHash = rawTool["hash"];
			if (typeof toolName !== "string" || !isName(toolHash)) {
				return bad("a recipe pin has a tool without a name and a hash");
			}
			tools.push({ name: toolName, hash: toolHash });
		}
	}
	const recipe: RecipeStamp = { name, version, toolSetHash };
	if (instructionsHash !== undefined) {
		recipe.instructionsHash = instructionsHash;
	}
	if (tools !== undefined) {
		recipe.tools = tools;
	}
	return ok(recipe);
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
			const details = value["details"];
			const entry: UserMessageEntry = { type, ...base, label, text };
			if (details !== undefined) {
				if (!isJsonValue(details)) {
					return bad("a user_message entry has details that are not JSON");
				}
				entry.details = details;
			}
			return ok(entry);
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
			const retries = value["retries"];
			if (
				retries !== undefined &&
				(typeof retries !== "number" || !Number.isSafeInteger(retries) || retries < 0)
			) {
				return bad("an assistant_message entry has retries that are not a count");
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
			if (retries !== undefined) {
				entry.retries = retries;
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
			if (value["done"] === true) {
				entry.done = true;
			}
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
			const detail = value["detail"];
			if (!isState(state)) {
				return bad("a status entry has a state this build does not know");
			}
			if (reason !== undefined && !isName(reason)) {
				return bad("a status entry has a reason that is not text");
			}
			if (detail !== undefined && !isName(detail)) {
				return bad("a status entry has a detail that is not text");
			}
			const entry: StatusEntry = { type, ...base, state };
			if (reason !== undefined) {
				entry.reason = reason;
			}
			if (detail !== undefined) {
				entry.detail = detail;
			}
			return ok(entry);
		}
		case "note": {
			const kind = value["kind"];
			const text = value["text"];
			if (!isName(kind)) {
				return bad("a note entry has no kind");
			}
			if (typeof text !== "string") {
				return bad("a note entry has no text");
			}
			return ok({ type, ...base, kind, text });
		}
		case "recipe_updated": {
			const to = decodeStamp(value["to"]);
			if (!to.ok) {
				return to;
			}
			const rawFrom = value["from"];
			if (rawFrom === undefined) {
				return ok({ type, ...base, to: to.value });
			}
			const from = decodeStamp(rawFrom);
			if (!from.ok) {
				return from;
			}
			return ok({ type, ...base, from: from.value, to: to.value });
		}
		case "fallback": {
			const from = value["from"];
			const to = value["to"];
			const reason = value["reason"];
			if (!isName(from) || !isName(to)) {
				return bad("a fallback entry does not name both models");
			}
			if (typeof reason !== "string") {
				return bad("a fallback entry has no reason");
			}
			return ok({ type, ...base, from, to, reason });
		}
		default:
			return ok({ type: "unknown", ...base, raw });
	}
}
