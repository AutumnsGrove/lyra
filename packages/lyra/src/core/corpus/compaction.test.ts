import { test } from "vitest";

import { replay } from "../../testkit/corpus.testing.js";
import { cases, holds } from "./compaction.testing.js";

/**
 * CMP02 and CMP05, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run (issue #41).
 */
test("CMP02 the committed cases still hold", () => {
	replay("compaction", cases, holds);
});
