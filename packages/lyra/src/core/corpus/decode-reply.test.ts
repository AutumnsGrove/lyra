import { test } from "vitest";

import { replay } from "../../testkit/corpus.testing.js";
import { cases, holds } from "./decode-reply.testing.js";

/**
 * MOD10, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run, so the nightly
 * shuffled-and-repeated suite covers them too (issue #41).
 */
test("MOD10 the committed cases still hold", () => {
	replay("decode-reply", cases, holds);
});
