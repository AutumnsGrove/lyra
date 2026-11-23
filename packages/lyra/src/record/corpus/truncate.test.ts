import { test } from "vitest";

import { replay } from "../../testkit/corpus.testing.js";
import { cases, holds } from "./truncate.testing.js";

/**
 * REC04, replayed. Every committed case runs through the same property the
 * generator uses, in `pnpm test` rather than only in the fuzz run (issue #41).
 */
test("REC04 the committed cases still hold", () => {
	replay("truncate", cases, holds);
});
