/**
 * A person's answer to a request (docs/protocol.md, "Requests"; decisions 34, 85).
 *
 * `ui_response` is not a command — it answers a question the run asked rather than
 * telling Lyra to do something — so it gets its own decoder. The request is named
 * with `request` rather than Nova's `id`, because every frame in Lyra already has
 * an `id` and one frame using it for something else is a trap for later.
 */

import { fail, ok, type Result } from "../core/result.js";

/** What a client sends to answer a request. */
export interface RequestAnswer {
	/** The request id the client was shown. */
	request: string;
	/** Which session asked, since HTTP has no connection to say it. */
	session: string;
	/** True approves a call; anything else denies it. */
	ok: boolean;
	/** What the person said, which the model reads on a deny. */
	note?: string;
	/** A question's answer. */
	text?: string;
	/** A choice's answer: the ids of the options picked. */
	ids?: string[];
}

function bad(problem: string): Result<never> {
	return fail("bad_request", problem);
}

function textOf(fields: Record<string, unknown>, name: string): Result<string> {
	const value = fields[name];
	if (typeof value !== "string" || value === "") {
		return bad(`a ui_response needs a ${name} that is a non-empty string`);
	}
	return ok(value);
}

function optionalText(fields: Record<string, unknown>, name: string): Result<string | undefined> {
	const value = fields[name];
	if (value === undefined) {
		return ok(undefined);
	}
	if (typeof value !== "string") {
		return bad(`${name} must be text when it is there`);
	}
	return ok(value);
}

/**
 * One frame to one answer. An `ok` that is absent, false or `cancelled` is a deny:
 * a promise nobody made is not an approval (decision 37's default).
 */
export function decodeAnswer(frame: {
	type: string;
	fields: Record<string, unknown>;
}): Result<RequestAnswer> {
	if (frame.type !== "ui_response") {
		return bad(`a ${frame.type} frame is not an answer`);
	}
	const request = textOf(frame.fields, "request");
	if (!request.ok) {
		return request;
	}
	const session = textOf(frame.fields, "session");
	if (!session.ok) {
		return session;
	}
	const okField = frame.fields["ok"];
	if (okField !== undefined && typeof okField !== "boolean") {
		return bad("ok must be true or false when it is there");
	}
	const cancelled = frame.fields["cancelled"];
	if (cancelled !== undefined && typeof cancelled !== "boolean") {
		return bad("cancelled must be true or false when it is there");
	}
	const note = optionalText(frame.fields, "note");
	if (!note.ok) {
		return note;
	}
	const text = optionalText(frame.fields, "text");
	if (!text.ok) {
		return text;
	}

	const rawIds = frame.fields["ids"];
	let ids: string[] | undefined;
	if (rawIds !== undefined) {
		if (!Array.isArray(rawIds) || !rawIds.every((id): id is string => typeof id === "string")) {
			return bad("ids must be a list of strings when it is there");
		}
		ids = rawIds;
	}

	const answer: RequestAnswer = {
		request: request.value,
		session: session.value,
		ok: okField === true && cancelled !== true,
	};
	if (note.value !== undefined) {
		answer.note = note.value;
	}
	if (text.value !== undefined) {
		answer.text = text.value;
	}
	if (ids !== undefined) {
		answer.ids = ids;
	}
	return ok(answer);
}
