import { expect, test } from "vitest";
import { runTask } from "@autumnsgrove/lyra";
import { counterIds, memoryStorage } from "@autumnsgrove/lyra/memory";
import { fakeClock } from "@autumnsgrove/lyra/testkit";

import { PLACEHOLDER_MODEL } from "./model.js";
import { shellRecipe } from "./recipes/shell.js";

/**
 * The rows are in `docs/implementation/C-playground.md`, Slice 1: the shell deploys and
 * a run against it finishes. This drives the recipe and the placeholder model through
 * the real loop, which is what `pnpm lyra start` does through the protocol.
 */

test("PGS02 the shell's recipe finishes a run, so the deployment can be driven end to end", async () => {
	const storage = memoryStorage();
	const result = await runTask({
		runId: "run-1",
		task: "shell",
		host: "packages/playground",
		input: "say hello",
		system: shellRecipe.instructions,
		tools: shellRecipe.tools,
		model: PLACEHOLDER_MODEL,
		storage,
		clock: fakeClock(),
		ids: counterIds(),
	});

	expect(result.reason).toBe("done");
	// One turn, because the placeholder has nothing to decide: it calls finish at once.
	expect(result.turns).toBe(1);

	const saved = await storage.read();
	expect(saved.ok).toBe(true);
	if (!saved.ok) {
		return;
	}
	const lines = saved.value;
	const finish = lines.find((line) => line.includes('"name":"finish"'));
	expect(finish).toBeDefined();
});

test("PGS02 the placeholder model asks to finish rather than pretending to work", async () => {
	const reply = await PLACEHOLDER_MODEL.complete({
		system: shellRecipe.instructions,
		messages: [{ role: "user", text: "say hello" }],
		tools: shellRecipe.tools.map((tool) => tool.spec),
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(true);
	if (!reply.ok) {
		return;
	}
	expect(reply.value.toolCalls.map((call) => call.name)).toEqual(["finish"]);
	expect(reply.value.toolCalls[0]?.arguments).toBe("{}");
	// No cost is claimed, because no model was called: the day cap's unpriced rule
	// (Slice 7) has to be able to tell that apart from a reply that forgot to price.
	expect(reply.value.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	expect(reply.value.model).toBe("playground-placeholder");
});
