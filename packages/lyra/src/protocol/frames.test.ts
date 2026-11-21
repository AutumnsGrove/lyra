import { expect, test } from "vitest";

import {
	decodeFrame,
	encodeFrame,
	isResponseFrame,
	responseFrame,
	type ResponseFrame,
} from "./frames.js";

/**
 * The frame envelope (docs/protocol.md, FRM02 and FRM04). A frame is one JSON
 * line with a `type`; everything else is either a command's business or ignored,
 * and neither a bad line nor an unknown type is allowed to be fatal.
 */

test("FRM02 a command frame decodes with its fields intact", () => {
	const decoded = decodeFrame(
		JSON.stringify({
			type: "command",
			id: "c1",
			command: "start",
			task: "timeline",
			input: { day: "2026-11-21" },
			fromTheFuture: ["ignored", 1, null],
		}),
	);
	expect(decoded.ok).toBe(true);
	if (!decoded.ok) {
		return;
	}
	expect(decoded.value.type).toBe("command");
	expect(decoded.value.fields["command"]).toBe("start");
	expect(decoded.value.fields["fromTheFuture"]).toEqual(["ignored", 1, null]);
});

test("FRM02 a bad line is bad_request and an unknown type is unsupported", () => {
	const badJson = decodeFrame("{not json");
	expect(badJson.ok).toBe(false);
	expect(badJson.ok ? "" : badJson.error.code).toBe("bad_request");

	const notAnObject = decodeFrame("[]");
	expect(notAnObject.ok ? "" : notAnObject.error.code).toBe("bad_request");

	const noType = decodeFrame('{"id":"c1"}');
	expect(noType.ok ? "" : noType.error.code).toBe("bad_request");

	const unknown = decodeFrame('{"type":"compact_please"}');
	expect(unknown.ok ? "" : unknown.error.code).toBe("unsupported");
	expect(unknown.ok ? "" : unknown.error.message).toContain("compact_please");
});

test("FRM02 a frame encodes as one line with a newline", () => {
	const encoded = encodeFrame({ type: "command", id: "c1", command: "abort" });
	expect(encoded.endsWith("\n")).toBe(true);
	expect(encoded.trimEnd().split("\n")).toHaveLength(1);
	const decoded = decodeFrame(encoded.trimEnd());
	expect(decoded.ok && decoded.value.fields["command"]).toBe("abort");
});

test("FRM04 a response carries the command's own result", () => {
	const good = responseFrame("c1", "get_state", { ok: true, value: { state: "idle" } });
	expect(good).toEqual({
		type: "response",
		id: "c1",
		command: "get_state",
		ok: true,
		data: { state: "idle" },
	});
	expect(isResponseFrame(good)).toBe(true);

	const bad = responseFrame("c2", "start", {
		ok: false,
		error: { code: "bad_request", message: "the task needs an input" },
	});
	expect(bad).toEqual({
		type: "response",
		id: "c2",
		command: "start",
		ok: false,
		error: { code: "bad_request", message: "the task needs an input" },
	});
	expect(isResponseFrame(bad)).toBe(true);
});

test("FRM04 a code this build does not know is internal, not passed on", () => {
	const response: ResponseFrame = responseFrame("c3", "start", {
		ok: false,
		error: { code: "not_a_code", message: "something odd" },
	});
	expect(response.error?.code).toBe("internal");
});

test("FRM04 a frame that is not a response is not one", () => {
	for (const value of [
		null,
		{ type: "response" },
		{ type: "response", id: "c1", command: "x", ok: "yes" },
		{
			type: "response",
			id: "c1",
			command: "x",
			ok: false,
			error: { code: "nope", message: "" },
		},
		{ type: "command", id: "c1", command: "x", ok: true },
	]) {
		expect(isResponseFrame(value)).toBe(false);
	}
});
