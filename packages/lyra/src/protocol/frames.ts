/**
 * The frame envelope (docs/protocol.md, "Framing and hello"; decisions 43 and 83).
 *
 * One JSON object per line, with `type` saying what it is. This module owns the
 * envelope and the response shape and nothing else: each command validates its
 * own fields in `commands.ts`, so a decoder here cannot refuse a command it has
 * not been taught, and a field nobody knows is ignored rather than fatal (as in
 * Nova's protocol).
 */

import { isJsonValue, isPlainObject, type JsonObject, type JsonValue } from "../core/json.js";
import { isErrorCode, type ErrorCode, type Result } from "../core/result.js";

/**
 * The frame types Lyra speaks. `hello` is WebSocket-only (step 8); `ui_response`
 * answers a request rather than telling Lyra to do something, which is why it is
 * its own type and not a command (decision 34).
 */
export const FRAME_TYPES = ["hello", "command", "response", "event", "ui_response"] as const;

export type FrameType = (typeof FRAME_TYPES)[number];

export function isFrameType(value: unknown): value is FrameType {
	return FRAME_TYPES.some((type) => type === value);
}

/** A frame as it arrived: its type, and every other field, unvalidated. */
export interface DecodedFrame {
	type: FrameType;
	fields: JsonObject;
}

/**
 * One line to a frame. A bad line is `bad_request`; a frame type Lyra does not
 * speak is `unsupported`. Neither is fatal to a connection, which is what lets a
 * client send a command from a newer version and be told so.
 */
export function decodeFrame(line: string): Result<DecodedFrame> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return { ok: false, error: { code: "bad_request", message: "a frame was not JSON" } };
	}
	if (!isPlainObject(parsed)) {
		return { ok: false, error: { code: "bad_request", message: "a frame was not an object" } };
	}
	const type = parsed["type"];
	if (typeof type !== "string") {
		return {
			ok: false,
			error: { code: "bad_request", message: "a frame had no type" },
		};
	}
	if (!isFrameType(type)) {
		return {
			ok: false,
			error: {
				code: "unsupported",
				message: `the frame type "${type}" is not one Lyra speaks`,
			},
		};
	}
	const fields: JsonObject = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (key === "type") {
			continue;
		}
		// A frame's fields have to survive a round trip, because a record or a
		// response echoes them back. Anything that is not JSON is dropped here rather
		// than failing the frame, since JSON.parse can only produce JSON.
		if (isJsonValue(value)) {
			fields[key] = value;
		}
	}
	return { ok: true, value: { type, fields } };
}

/** One frame as one line, newline included. */
export function encodeFrame(frame: { type: FrameType } & JsonObject): string {
	return `${JSON.stringify(frame)}\n`;
}

/** The answer to a command, in Nova's shape (docs/protocol.md, "Commands"). */
export interface ResponseFrame {
	type: "response";
	id: string;
	command: string;
	ok: boolean;
	data?: JsonValue;
	error?: { code: ErrorCode; message: string };
}

/** A response frame from what the command did, which is always a `Result`. */
export function responseFrame(
	id: string,
	command: string,
	outcome:
		{ ok: true; value: JsonValue } | { ok: false; error: { code: string; message: string } },
): ResponseFrame {
	if (outcome.ok) {
		return { type: "response", id, command, ok: true, data: outcome.value };
	}
	const code = isErrorCode(outcome.error.code) ? outcome.error.code : "internal";
	return {
		type: "response",
		id,
		command,
		ok: false,
		error: { code, message: outcome.error.message },
	};
}

export function isResponseFrame(value: unknown): value is ResponseFrame {
	if (!isPlainObject(value) || value["type"] !== "response") {
		return false;
	}
	if (typeof value["id"] !== "string" || typeof value["command"] !== "string") {
		return false;
	}
	if (typeof value["ok"] !== "boolean") {
		return false;
	}
	if (value["ok"]) {
		return value["data"] === undefined || isJsonValue(value["data"]);
	}
	const error = value["error"];
	return (
		isPlainObject(error) && isErrorCode(error["code"]) && typeof error["message"] === "string"
	);
}
