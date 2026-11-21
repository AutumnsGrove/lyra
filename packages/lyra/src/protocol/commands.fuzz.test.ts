import fc from "fast-check";
import { expect, test } from "vitest";

import { decodeCommand } from "./commands.js";
import { decodeFrame } from "./frames.js";

/**
 * CMD15 in `docs/protocol.md`. A command is the only thing a client can make Lyra
 * do, and every frame it sends is hostile until validated, so the validator is a
 * fuzz target: whatever the fields are, it answers with a command or a refusal that
 * names the field, and never with a throw.
 */

const name = fc.constantFrom(
	"start",
	"prompt",
	"steer",
	"follow_up",
	"abort",
	"resume",
	"get_state",
	"get_messages",
	"compact",
	"list_sessions",
	"list_pending",
	"decide_proposal",
	"nonsense",
	"",
);

const value = fc.oneof(
	fc.string({ maxLength: 20 }),
	fc.nat({ max: 1_000 }),
	fc.boolean(),
	fc.constant(null),
	fc.array(fc.string({ maxLength: 5 }), { maxLength: 3 }),
	fc.constant({ nested: { deep: [1, 2] } }),
);

const fields = fc.dictionary(fc.string({ maxLength: 12 }), value, { maxKeys: 8 });

test("CMD15 any frame at all is a command or a refusal, never a throw", () => {
	fc.assert(
		fc.property(
			name,
			fields,
			fc.oneof(fc.string({ maxLength: 10 }), fc.constant(undefined)),
			(claimed, bag, id) => {
				// The generated fields go in first, so they fuzz the command rather than
				// the envelope: a bag with a `type` of its own would otherwise replace the
				// frame's and this would test the frame decoder instead.
				const parsed = decodeFrame(
					JSON.stringify({
						...bag,
						type: "command",
						...(id === undefined ? {} : { id }),
						command: claimed,
					}),
				);
				// The frame is always a JSON object with `type: "command"` once the bag is
				// spread in first, so this can only fail if the decoder itself regressed;
				// it is the guard that a well-formed command frame is still accepted.
				expect(parsed.ok).toBe(true);
				if (!parsed.ok) {
					return;
				}
				const decoded = decodeCommand(parsed.value);
				if (decoded.ok) {
					// Whatever it accepted, it is one of the commands this build speaks and
					// it carries the id it was answered with.
					expect(typeof decoded.value.id).toBe("string");
					expect(decoded.value.id).not.toBe("");
				} else {
					expect(["bad_request", "unsupported"]).toContain(decoded.error.code);
					expect(decoded.error.message.length).toBeGreaterThan(0);
				}
			},
		),
		{ numRuns: 300 },
	);
});
