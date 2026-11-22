/**
 * Commands (docs/protocol.md, "Commands"; decision 83).
 *
 * A decoded frame is a bag of JSON. This module turns one into a typed command,
 * or refuses it with the field that was wrong, so nothing further in the protocol
 * has to handle a field it did not expect. A command name Lyra knows but has not
 * built yet is `unsupported` rather than an error, so a client can tell the
 * difference between "not yet" and "not allowed", and a name nobody knows is
 * `unsupported` too.
 */

import { isJsonValue, type JsonValue } from "../core/json.js";
import { DEFAULT_ENTRY_CAP_BYTES } from "../core/run.js";
import { fail, ok, type Result } from "../core/result.js";
import { utf8Length } from "../record/truncate.js";

export type Command =
	| {
			command: "start";
			id: string;
			task: string;
			input: JsonValue;
			session?: string;
			key?: string;
	  }
	| { command: "prompt"; id: string; session: string; text: string; queue: boolean }
	| { command: "steer"; id: string; session: string; text: string }
	| { command: "follow_up"; id: string; session: string; text: string }
	| { command: "abort"; id: string; session: string }
	| { command: "resume"; id: string; session: string }
	| { command: "get_state"; id: string; session?: string }
	| { command: "compact"; id: string; session: string; instructions?: string }
	| { command: "list_pending"; id: string; session?: string }
	| {
			command: "decide_proposal";
			id: string;
			proposal: string;
			decision: "accept" | "reject";
			note?: string;
			session?: string;
	  }
	| {
			command: "get_messages";
			id: string;
			session: string;
			entry?: string;
			limit?: number;
			cursor?: string;
	  };

/** Commands the protocol names and this build answers `unsupported`, by slice. */
const LATER: Readonly<Record<string, string>> = {
	list_sessions: "listing every session needs an index of its own, which is not built yet",
};

export interface CommandOptions {
	/** The largest text a command may carry, which is the record's own cap (decision 90). */
	maxTextBytes?: number;
}

function bad(problem: string): Result<never> {
	return fail("bad_request", problem);
}

function textOf(fields: Record<string, unknown>, name: string): Result<string> {
	const value = fields[name];
	if (typeof value !== "string" || value === "") {
		return bad(`a command needs a ${name} that is a non-empty string`);
	}
	return ok(value);
}

function optionalText(fields: Record<string, unknown>, name: string): Result<string | undefined> {
	const value = fields[name];
	if (value === undefined) {
		return ok(undefined);
	}
	if (typeof value !== "string" || value === "") {
		return bad(`${name} must be a non-empty string when it is there`);
	}
	return ok(value);
}

function optionalCount(fields: Record<string, unknown>, name: string): Result<number | undefined> {
	const value = fields[name];
	if (value === undefined) {
		return ok(undefined);
	}
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		return bad(`${name} must be a positive whole number when it is there`);
	}
	return ok(value);
}

/**
 * One frame to one command. The id comes first, because every refusal has to be
 * answerable, and an unanswerable command is worse than a refused one.
 */
export function decodeCommand(
	frame: { type: string; fields: Record<string, unknown> },
	options: CommandOptions = {},
): Result<Command> {
	if (frame.type !== "command") {
		return bad(`a ${frame.type} frame is not a command`);
	}
	const id = textOf(frame.fields, "id");
	if (!id.ok) {
		return id;
	}
	const name = textOf(frame.fields, "command");
	if (!name.ok) {
		return name;
	}

	const later = LATER[name.value];
	if (later !== undefined) {
		return fail("unsupported", `${name.value} is not built yet: ${later}`);
	}

	const session = optionalText(frame.fields, "session");
	if (!session.ok) {
		return session;
	}

	switch (name.value) {
		case "start": {
			const task = textOf(frame.fields, "task");
			if (!task.ok) {
				return task;
			}
			const input = frame.fields["input"];
			if (typeof input !== "string" && !isJsonValue(input)) {
				return bad("a start needs an input, as text or as JSON");
			}
			const key = optionalText(frame.fields, "key");
			if (!key.ok) {
				return key;
			}
			const command: Command = { command: "start", id: id.value, task: task.value, input };
			if (session.value !== undefined) {
				command.session = session.value;
			}
			if (key.value !== undefined) {
				command.key = key.value;
			}
			return ok(command);
		}
		case "prompt":
		case "steer":
		case "follow_up": {
			const text = textOf(frame.fields, "text");
			if (!text.ok) {
				return text;
			}
			const needed = session.value;
			if (needed === undefined) {
				return bad(`a ${name.value} needs a session that is a non-empty string`);
			}
			const cap = options.maxTextBytes ?? DEFAULT_ENTRY_CAP_BYTES;
			if (utf8Length(text.value) > cap) {
				return bad(
					`text is too long: ${utf8Length(text.value)} bytes is over the ${cap} a command may carry`,
				);
			}
			if (name.value === "prompt") {
				const queue = frame.fields["queue"];
				if (queue !== undefined && typeof queue !== "boolean") {
					return bad("queue must be true or false when it is there");
				}
				return ok({
					command: "prompt",
					id: id.value,
					session: needed,
					text: text.value,
					queue: queue === true,
				});
			}
			return name.value === "steer"
				? ok({ command: "steer", id: id.value, session: needed, text: text.value })
				: ok({ command: "follow_up", id: id.value, session: needed, text: text.value });
		}
		case "compact": {
			const needed = session.value;
			if (needed === undefined) {
				return bad("a compact needs a session that is a non-empty string");
			}
			const instructions = optionalText(frame.fields, "instructions");
			if (!instructions.ok) {
				return instructions;
			}
			const cap = options.maxTextBytes ?? DEFAULT_ENTRY_CAP_BYTES;
			if (instructions.value !== undefined && utf8Length(instructions.value) > cap) {
				return bad(
					`instructions are too long: ${utf8Length(instructions.value)} bytes is over the ${cap} a command may carry`,
				);
			}
			const command: Extract<Command, { command: "compact" }> = {
				command: "compact",
				id: id.value,
				session: needed,
			};
			if (instructions.value !== undefined) {
				command.instructions = instructions.value;
			}
			return ok(command);
		}
		case "abort":
		case "resume": {
			const needed = session.value;
			if (needed === undefined) {
				return bad(`an ${name.value} needs a session that is a non-empty string`);
			}
			return ok({ command: name.value, id: id.value, session: needed });
		}
		case "decide_proposal": {
			const proposal = textOf(frame.fields, "proposal");
			if (!proposal.ok) {
				return proposal;
			}
			const decision = frame.fields["decision"];
			if (decision !== "accept" && decision !== "reject") {
				return bad("decision must be accept or reject");
			}
			const note = optionalText(frame.fields, "note");
			if (!note.ok) {
				return note;
			}
			const command: Extract<Command, { command: "decide_proposal" }> = {
				command: "decide_proposal",
				id: id.value,
				proposal: proposal.value,
				decision,
			};
			if (session.value !== undefined) {
				command.session = session.value;
			}
			if (note.value !== undefined) {
				command.note = note.value;
			}
			return ok(command);
		}
		case "list_pending":
			return ok({
				command: "list_pending",
				id: id.value,
				...(session.value === undefined ? {} : { session: session.value }),
			});
		case "get_state": {
			const command: Command = { command: "get_state", id: id.value };
			if (session.value !== undefined) {
				command.session = session.value;
			}
			return ok(command);
		}
		case "get_messages": {
			const needed = session.value;
			if (needed === undefined) {
				return bad("a get_messages needs a session that is a non-empty string");
			}
			const entry = optionalText(frame.fields, "entry");
			if (!entry.ok) {
				return entry;
			}
			const limit = optionalCount(frame.fields, "limit");
			if (!limit.ok) {
				return limit;
			}
			const cursor = optionalText(frame.fields, "cursor");
			if (!cursor.ok) {
				return cursor;
			}
			const command: Command = { command: "get_messages", id: id.value, session: needed };
			if (entry.value !== undefined) {
				command.entry = entry.value;
			}
			if (limit.value !== undefined) {
				command.limit = limit.value;
			}
			if (cursor.value !== undefined) {
				command.cursor = cursor.value;
			}
			return ok(command);
		}
		default:
			return fail("unsupported", `the command "${name.value}" is not one Lyra speaks`);
	}
}
