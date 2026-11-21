import { expect, test } from "vitest";

import { decodeFrame } from "./frames.js";
import { decodeCommand, type Command } from "./commands.js";

/**
 * The command validator (docs/protocol.md, CMD13 to CMD16). A command is the only
 * thing a client can make Lyra do, so what it accepts is narrow, what it refuses
 * names the field, and nothing it refuses is acted on.
 */

function commandOf(fields: Record<string, unknown>): Command {
	const frame = decodeFrame(JSON.stringify({ type: "command", id: "c1", ...fields }));
	if (!frame.ok) {
		throw new Error(frame.error.message);
	}
	const decoded = decodeCommand(frame.value);
	if (!decoded.ok) {
		throw new Error(`expected a command, got ${decoded.error.code}: ${decoded.error.message}`);
	}
	return decoded.value;
}

function refusalOf(fields: Record<string, unknown>): { code: string; message: string } {
	const frame = decodeFrame(JSON.stringify({ type: "command", id: "c1", ...fields }));
	if (!frame.ok) {
		throw new Error(frame.error.message);
	}
	const decoded = decodeCommand(frame.value);
	if (decoded.ok) {
		throw new Error("expected a refusal, got a command");
	}
	return decoded.error;
}

test("CMD14 each command validates into its own shape", () => {
	expect(commandOf({ command: "start", task: "timeline", input: { day: "2026-11-21" } })).toEqual(
		{
			command: "start",
			id: "c1",
			task: "timeline",
			input: { day: "2026-11-21" },
		},
	);
	// A text input is what a plain task takes, so both are allowed.
	expect(commandOf({ command: "start", task: "t", input: "do the thing" })).toEqual({
		command: "start",
		id: "c1",
		task: "t",
		input: "do the thing",
	});
	expect(commandOf({ command: "prompt", session: "s1", text: "hello" })).toEqual({
		command: "prompt",
		id: "c1",
		session: "s1",
		text: "hello",
		queue: false,
	});
	expect(commandOf({ command: "prompt", session: "s1", text: "hello", queue: true })).toEqual({
		command: "prompt",
		id: "c1",
		session: "s1",
		text: "hello",
		queue: true,
	});
	expect(commandOf({ command: "steer", session: "s1", text: "go left" })).toEqual({
		command: "steer",
		id: "c1",
		session: "s1",
		text: "go left",
	});
	expect(commandOf({ command: "follow_up", session: "s1", text: "and then?" })).toEqual({
		command: "follow_up",
		id: "c1",
		session: "s1",
		text: "and then?",
	});
	expect(commandOf({ command: "abort", session: "s1" })).toEqual({
		command: "abort",
		id: "c1",
		session: "s1",
	});
	expect(commandOf({ command: "resume", session: "s1" })).toEqual({
		command: "resume",
		id: "c1",
		session: "s1",
	});
	expect(commandOf({ command: "get_state" })).toEqual({ command: "get_state", id: "c1" });
	expect(commandOf({ command: "get_messages", session: "s1", limit: 20, entry: "e2" })).toEqual({
		command: "get_messages",
		id: "c1",
		session: "s1",
		limit: 20,
		entry: "e2",
	});
});

test("CMD15 a bad command is refused by the field that is wrong", () => {
	const cases: [Record<string, unknown>, string][] = [
		[{ command: "start", input: "x" }, "task"],
		[{ command: "start", task: "t" }, "input"],
		[{ command: "start", task: 5, input: "x" }, "task"],
		[{ command: "prompt", text: "x" }, "session"],
		[{ command: "prompt", session: "s1" }, "text"],
		[{ command: "prompt", session: "s1", text: "x", queue: "yes" }, "queue"],
		[{ command: "get_messages", session: "s1", limit: 0 }, "limit"],
		[{ command: "get_messages", session: "s1", limit: 1.5 }, "limit"],
		[{ command: "get_messages", session: "s1", entry: 7 }, "entry"],
	];
	for (const [fields, field] of cases) {
		const refusal = refusalOf(fields);
		expect({ fields, code: refusal.code }).toEqual({ fields, code: "bad_request" });
		expect(refusal.message).toContain(field);
	}
});

test("CMD15 a frame that is not a command, or has no id, is refused", () => {
	const notACommand = decodeCommand({ type: "response", fields: {} });
	expect(notACommand.ok ? "" : notACommand.error.code).toBe("bad_request");

	const noId = decodeCommand({ type: "command", fields: { command: "get_state" } });
	expect(noId.ok ? "" : noId.error.code).toBe("bad_request");
	expect(noId.ok ? "" : noId.error.message).toContain("id");

	const emptyId = decodeCommand({ type: "command", fields: { id: "", command: "get_state" } });
	expect(emptyId.ok ? "" : emptyId.error.code).toBe("bad_request");
});

test("CMD13 text over the entry cap is refused and saves nothing", () => {
	const refusal = refusalOf({ command: "steer", session: "s1", text: "x".repeat(1_200_000) });
	expect(refusal.code).toBe("bad_request");
	expect(refusal.message).toContain("too long");
});

test("CMD16 a command for a later slice is unsupported, and says which", () => {
	for (const command of ["compact", "list_sessions", "list_pending", "decide_proposal"]) {
		const refusal = refusalOf({ command, session: "s1" });
		expect({ command, code: refusal.code }).toEqual({ command, code: "unsupported" });
	}
	const unknown = refusalOf({ command: "make_coffee" });
	expect(unknown.code).toBe("unsupported");
	expect(unknown.message).toContain("make_coffee");
});
