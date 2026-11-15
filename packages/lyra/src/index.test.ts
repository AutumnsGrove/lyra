import { expect, test } from "vitest";

import * as core from "./index.js";

test("the core entry point loads on a standard runtime", () => {
	expect(core).toBeTypeOf("object");
});
