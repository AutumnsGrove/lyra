import fc from "fast-check";
import { expect, test } from "vitest";

import { decodeAnswer } from "./answers.js";

/**
 * REQ04 in `docs/protocol.md`: an answer arrives from outside, so every field is
 * hostile until the decoder says otherwise. Seeds print on failure.
 */
test("REQ04 no answer frame can make the decoder throw", () => {
	fc.assert(
		fc.property(
			fc.oneof(
				fc.anything(),
				fc.dictionary(fc.string(), fc.anything()),
				fc.record({
					request: fc.oneof(fc.string(), fc.integer(), fc.constant(null)),
					session: fc.oneof(fc.string(), fc.boolean()),
					ok: fc.oneof(fc.boolean(), fc.string(), fc.constant(undefined)),
					note: fc.oneof(fc.string(), fc.array(fc.anything())),
					text: fc.oneof(fc.string(), fc.integer()),
					ids: fc.oneof(fc.array(fc.string()), fc.array(fc.anything()), fc.string()),
				}),
			),
			(shape) => {
				const fields =
					typeof shape === "object" && shape !== null && !Array.isArray(shape)
						? (shape as Record<string, unknown>)
						: {};
				const outcome = decodeAnswer({ type: "ui_response", fields });
				expect(outcome.ok || outcome.error.code === "bad_request").toBe(true);
			},
		),
		{ numRuns: 400 },
	);
});
