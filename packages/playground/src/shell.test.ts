import { expect, test } from "vitest";
import { runTask } from "@autumnsgrove/lyra";
import { counterIds, memoryStorage } from "@autumnsgrove/lyra/memory";
import { fakeClock } from "@autumnsgrove/lyra/testkit";

import type { Env } from "./session.js";
import { sessionOptions, tokensFrom } from "./session.js";
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
		INDEX: {} as DurableObjectNamespace,
		LYRA_PLAYGROUND_TOKEN: "a-playground-token-for-a-test",
		LYRA_PLAYGROUND_TENANT: "playground",
		// The placeholder source, so the run is driven by the loop without a key or a
		// socket. The real slot is `model.test.ts`'s subject.
		MODEL_SOURCE: "placeholder",
	};
}

test("PGS01 the playground's old binding names bind nothing", () => {
	// The vault's rule is that a name says which project it belongs to, so the two
	// playground bindings are prefixed. A deployment still carrying the old secret must
	// not keep working: that would leave a name nobody chose opening the door, which is
	// the same shape as the empty-token bug review found on #81.
	const stale = {
		SESSION: {} as DurableObjectNamespace,
		INDEX: {} as DurableObjectNamespace,
		PLAYGROUND_TOKEN: "an-old-token-for-a-test",
		PLAYGROUND_TENANT: "playground",
	} as unknown as Env;
	expect(tokensFrom(stale)).toEqual({});
});

test("PGS02 the session's own options can finish a run, so a deployment can be driven", async () => {
	const options = sessionOptions(env());

	// What the object will look up when a `start` names the recipe.
	const recipe = options.recipes.get("shell");
	expect(recipe).toBe(shellRecipe);
	// The page's own recipe is here as well: a `start` that names `tool-table` is the
	// thing slice 2 exists for, so a map that only carried the shell would be a deploy
	// that answers the person's first click with an unknown recipe.
	expect([...options.recipes.keys()]).toEqual(["shell", "tool-table"]);
	// Slice 5's whole table, in the order the recipe carries it: a tool the map lost is a
	// model that cannot be told to use it, and a test that only checked `now` would let a
	// dropped write through.
	expect(options.recipes.get("tool-table")?.tools.map((tool) => tool.spec.name)).toEqual([
		"now",
		"calculator",
		"notes_read",
		"notes_list",
		"flaky",
		"slow",
		"big_result",
		"notes_write",
		"notes_delete",
		"ask_person",
		"propose_summary",
		"finish",
	]);
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

test("PGS02 a follow-up finishes its own segment, rather than parking stuck", async () => {
	// A follow-up continues the run as a new segment (decision 44), and each segment gets
	// its own `finish`. A segment that answers text and never finishes is exactly what the
	// stuck safeguard catches, so the shell parked `stuck` on every follow-up; driving the
	// same follow-up through the loop is what showed it (found in review on #81, after a
	// hand-built request had asserted the opposite).
	const options = sessionOptions(env());
	const storage = memoryStorage();
	const config = {
		runId: "run-1",
		task: "shell",
		host: options.host,
		input: "say hello",
		system: shellRecipe.instructions,
		tools: shellRecipe.tools,
		model: options.model,
		storage,
		clock: fakeClock(),
		ids: counterIds(),
	};

	const first = await runTask(config);
	expect(first.reason).toBe("done");

	const lines = await storage.read();
	expect(lines.ok).toBe(true);
	if (!lines.ok) {
		return;
	}
	const second = await runTask({
		...config,
		resume: { lines: lines.value, by: "person", followUp: "and again" },
	});

	expect(second.reason).toBe("done");
	expect(second.parkedReason).toBeUndefined();
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
	// (slice 7) has to be able to tell that apart from a reply that forgot to price, so
	// the absence of the key is the assertion rather than a value `toEqual` would let
	// through as `undefined`.
	expect(reply.value.usage).not.toHaveProperty("cost");
	expect(reply.value.usage).toStrictEqual({ inputTokens: 0, outputTokens: 0 });
	expect(reply.value.model).toBe(PLACEHOLDER_MODEL_NAME);
});
