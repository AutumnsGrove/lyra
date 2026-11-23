import { test } from "vitest";

import { replay } from "../../testkit/corpus.testing.js";
import { cases, holds } from "./load.testing.js";

/**
 * RCD07, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run (issue #41).
 */
test("RCD07 the committed cases still hold", () => {
	replay("load", cases, holds);
});
