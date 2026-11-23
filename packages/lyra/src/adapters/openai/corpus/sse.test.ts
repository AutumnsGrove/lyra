import { test } from "vitest";

import { replay } from "../../../testkit/corpus.testing.js";
import { cases, holds } from "./sse.testing.js";

/**
 * OAI13, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run, so the nightly
 * shuffled-and-repeated suite covers them too (issue #41).
 */
test("OAI13 the committed cases still hold", () => {
	replay("sse", cases, holds);
});
