import { expect } from "vitest";

import { decodeAnswer } from "../answers.js";

/**
 * The committed cases for REQ04, and the property they hold. An answer comes from
 * outside — a person's client, a script, a proxy — so every field is hostile until
 * the decoder says otherwise. Each case is one of the shapes a client has plausibly
 * sent: an approval with a note, a deny with no `ok`, an `ok` that is a string, a
 * request that is a number.
 *
 * The property lives here so the generator in `answers.fuzz.test.ts` and the replay
 * in `corpus/answers.test.ts` share one definition (issue #41).
 */

export const cases: Readonly<Record<string, unknown>> = {
	"an-approval-with-a-note": { request: "req_1", ok: true, note: "looks fine" },
	"a-deny-with-no-ok": { request: "req_1", note: "no" },
	"an-ok-that-is-a-string": { request: "req_1", ok: "true" },
	"a-request-that-is-a-number": { request: 42, ok: true },
	"a-missing-request": { ok: true },
	"ids-as-a-string-instead-of-a-list": { request: "req_1", ok: true, ids: "one" },
	"a-line-separator-in-the-note": { request: "req_1", ok: false, note: "\u2028" },
	"nothing-at-all": null,
	"an-array-instead-of-fields": [1, 2, 3],
	"a-field-named-type": { request: "req_1", ok: true, type: "ui_response" },
};

/**
 * The property, shared by the generator and the replay: an answer decodes or is
 * refused as a bad request, and never throws.
 */
export function holds(shape: unknown): void {
	const fields =
		typeof shape === "object" && shape !== null && !Array.isArray(shape)
			? (shape as Record<string, unknown>)
			: {};
	const outcome = decodeAnswer({ type: "ui_response", fields });
	expect(outcome.ok || outcome.error.code === "bad_request").toBe(true);
}
