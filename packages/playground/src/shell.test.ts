import { expect, test } from "vitest";
import { runTask } from "@autumnsgrove/lyra";
import { counterIds, memoryStorage } from "@autumnsgrove/lyra/memory";
import { fakeClock } from "@autumnsgrove/lyra/testkit";

import type { Env } from "./session.js";
import { sessionOptions } from "./session.js";
import { PLACEHOLDER_MODEL, PLACEHOLDER_MODEL_NAME } from "./model.js";
import { shellRecipe } from "./recipes/shell.js";

/**
 * The row is in `docs/playground.md`: PGS02.
 *
 * The subject is `sessionOptions`, which is the host's whole answer to the adapter: if
 * it keyed the recipe differently, dropped the model, or built the token map wrong,
 * every other test here would stay green and a deploy would answer a `start` with an
 * unknown recipe. So the run is driven by what that map actually holds.
 */

function env(): Env {
	return {
		SESSION: {} as DurableObjectNamespace,
		PLAYGROUND_TOKEN: "a-playground-token-for-a-test",
		PLAYGROUND_TENANT: "playground",
	};
}

test("PGS02 the session's own options can finish a run, so a deployment can be driven", async () => {
	const options = sessionOptions(env());

	// What the object will look up when a `start` names the recipe.
	const recipe = options.recipes.get("shell");
	expect(recipe).toBe(shellRecipe);
	expect([...options.recipes.keys()]).toEqual(["shell"]);
	expect(options.model).toBe(PLACEHOLDER_MODEL);
	expect(options.tokens).toEqual({ playground: "a-playground-token-for-a-test" });

	const storage = memoryStorage();
	const result = await runTask({
		runId: "run-1",
		task: "shell",
		host: options.host,
		input: "say hello",
		system: recipe?.instructions ?? "",
		tools: recipe?.tools ?? [],
		model: options.model,
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
	expect(saved.value.some((line) => line.includes('"name":"finish"'))).toBe(true);
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
	// (slice 7) has to be able to tell that apart from a reply that forgot to price.
	expect(reply.value.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	expect(reply.value.model).toBe(PLACEHOLDER_MODEL_NAME);
});
