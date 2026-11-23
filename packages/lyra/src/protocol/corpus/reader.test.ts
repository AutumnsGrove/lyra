import { test } from "vitest";

import { replay } from "../../testkit/corpus.testing.js";
import { cases, holds } from "./reader.testing.js";

/**
 * FRM03, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run, so the nightly
 * shuffled-and-repeated suite covers them too (issue #41).
 */
test("FRM03 the committed cases still hold", () => {
	replay("reader", cases, holds);
});
