import { expect } from "vitest";

import { decodeCommand } from "../commands.js";
import { decodeFrame } from "../frames.js";

/**
 * The committed cases for CMD15, and the property they hold. A command is the only
 * thing a client can make Lyra do, and every frame it sends is hostile until
 * validated. Each case is a real command from `docs/protocol.md` beside the ones
 * that should be refused: a task that is a number, an empty name, a bag that
 * overrides the envelope's own `type`.
 *
 * The property lives here so the generator in `commands.fuzz.test.ts` and the
 * replay in `corpus/commands.test.ts` share one definition (issue #41).
 */

/** `[the claimed command name, the rest of the fields, the frame id or none]`. */
export type CommandCase = readonly [string, Readonly<Record<string, unknown>>, string | undefined];

export const cases: Readonly<Record<string, CommandCase>> = {
	"start-with-a-task": ["start", { task: "timeline", input: {} }, "c1"],
	"start-with-no-frame-id": ["start", { task: "timeline" }, undefined],
	"start-with-a-task-that-is-a-number": ["start", { task: 42 }, "c2"],
	"start-with-an-input-that-is-null": ["start", { task: "timeline", input: null }, undefined],
	"abort-with-nothing-else": ["abort", {}, "c3"],
	"compact-with-instructions": ["compact", { instructions: "keep the last day" }, "c4"],
	"decide-proposal-approving": [
		"decide_proposal",
		{ proposal: "p1", decision: "approve", note: "ship it" },
		"c5",
	],
	"get-messages-from-a-cursor": ["get_messages", { cursor: "e9", limit: 0 }, "c6"],
	"a-command-this-build-does-not-speak": ["nonsense", {}, "c7"],
	"an-empty-command-name": ["", {}, ""],
	"a-bag-that-overrides-the-envelope": ["start", { type: "event", task: "x" }, "c8"],
};

/**
 * The property, shared by the generator and the replay: whatever the fields are,
 * the validator answers with a command or a refusal that names the field, and never
 * throws.
 */
export function holds([claimed, bag, id]: CommandCase): void {
	// The generated fields go in first, so they fuzz the command rather than the
	// envelope: a bag with a `type` of its own would otherwise replace the frame's
	// and this would test the frame decoder instead.
	const parsed = decodeFrame(
		JSON.stringify({
			...bag,
			type: "command",
			...(id === undefined ? {} : { id }),
			command: claimed,
		}),
	);
	// The frame is always a JSON object with `type: "command"` once the bag is spread
	// in first, so this can only fail if the decoder itself regressed; it is the guard
	// that a well-formed command frame is still accepted.
	expect(parsed.ok).toBe(true);
	if (!parsed.ok) {
		return;
	}
	const decoded = decodeCommand(parsed.value);
	if (decoded.ok) {
		// Whatever it accepted, it is one of the commands this build speaks and it
		// carries the id it was answered with.
		expect(typeof decoded.value.id).toBe("string");
		expect(decoded.value.id).not.toBe("");
	} else {
		expect(["bad_request", "unsupported"]).toContain(decoded.error.code);
		expect(decoded.error.message.length).toBeGreaterThan(0);
	}
}
