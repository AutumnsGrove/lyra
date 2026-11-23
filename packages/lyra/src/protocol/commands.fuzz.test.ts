import fc from "fast-check";
import { test } from "vitest";

import { generate } from "../testkit/corpus.testing.js";
import { holds } from "./corpus/commands.testing.js";

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
	generate(
		"commands",
		fc.tuple(name, fields, fc.oneof(fc.string({ maxLength: 10 }), fc.constant(undefined))),
		holds,
		{ numRuns: 300 },
	);
});
