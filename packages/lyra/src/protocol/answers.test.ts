import { expect, test } from "vitest";

import type { JsonObject } from "../core/json.js";
import { decodeAnswer } from "./answers.js";

/** The row is APR12 in `docs/approvals.md`, and REQ03 and REQ04 in `docs/protocol.md`. */

function decoded(fields: JsonObject) {
	const outcome = decodeAnswer({ type: "ui_response", fields });
	if (!outcome.ok) {
		throw new Error(`expected an answer, got ${outcome.error.code}: ${outcome.error.message}`);
	}
	return outcome.value;
}

function refusalOf(fields: JsonObject) {
	const outcome = decodeAnswer({ type: "ui_response", fields });
	if (outcome.ok) {
		throw new Error("expected a refusal, got an answer");
	}
	return outcome.error;
}

test("APR12 an answer decodes with its request, its session and its decision", () => {
	expect(
		decoded({
			request: "auth-1",
			session: "s1",
			ok: true,
			note: "yes, but on staging",
			text: "the answer",
			ids: ["a", "b"],
		}),
	).toEqual({
		request: "auth-1",
		session: "s1",
		ok: true,
		note: "yes, but on staging",
		text: "the answer",
		ids: ["a", "b"],
	});
});

test("APR12 anything but a clear yes is a deny", () => {
	for (const fields of [
		{ request: "r", session: "s" },
		{ request: "r", session: "s", ok: false },
		{ request: "r", session: "s", ok: true, cancelled: true },
	]) {
		expect({ fields, ok: decoded(fields).ok }).toEqual({ fields, ok: false });
	}
});

test("APR12 a field that is not the shape this build knows is bad_request, naming it", () => {
	expect(refusalOf({ session: "s1" }).message).toContain("request");
	expect(refusalOf({ request: "auth-1" }).message).toContain("session");
	expect(refusalOf({ request: "", session: "s1" }).message).toContain("request");
	expect(refusalOf({ request: "r", session: "s1", ok: "yes" }).message).toContain("ok");
	expect(refusalOf({ request: "r", session: "s1", cancelled: "no" }).message).toContain(
		"cancelled",
	);
	expect(refusalOf({ request: "r", session: "s1", note: 1 }).message).toContain("note");
	expect(refusalOf({ request: "r", session: "s1", text: 1 }).message).toContain("text");
	expect(refusalOf({ request: "r", session: "s1", ids: "a" }).message).toContain("ids");
	expect(refusalOf({ request: "r", session: "s1", ids: [1] }).message).toContain("ids");
	// A frame that is not an answer at all is refused rather than read.
	const notAnAnswer = decodeAnswer({ type: "command", fields: { request: "r", session: "s" } });
	expect(notAnAnswer.ok ? "" : notAnAnswer.error.message).toContain("command");
});

test("APR12 a field this build does not know is ignored", () => {
	expect(decoded({ request: "r", session: "s1", ok: true, fromTheFuture: { a: 1 } })).toEqual({
		request: "r",
		session: "s1",
		ok: true,
	});
});
