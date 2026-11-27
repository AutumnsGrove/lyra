import { expect, test } from "vitest";

import { runTask } from "@autumnsgrove/lyra";
import { counterIds, memoryStorage } from "@autumnsgrove/lyra/memory";
import { FAKE_CLOCK_START, fakeClock, scriptedModel } from "@autumnsgrove/lyra/testkit";

import { chatRecipe } from "./chat.js";

/** The rows are in `docs/playground.md`: PGS48. */

const clock = fakeClock();

test("PGS48 chat ends on its reply, so there is no finish to forget", async () => {
	const recipe = chatRecipe({ clock });

	expect(recipe.name).toBe("chat");
	expect(recipe.ending).toBe("reply");
	// A conversation may still look the time up, and there is no `finish` at all: the
	// two endings are refused together (decision 163).
	expect(recipe.tools.map((tool) => tool.spec.name)).toEqual(["now", "calculator"]);
	expect(recipe.tools.some((tool) => tool.finish === true)).toBe(false);

	const storage = memoryStorage();
	const model = scriptedModel(
		[{ text: "A chair by the fire, and the hour you spend in it." }, { text: "never asked" }],
		{ clock },
	);
	const result = await runTask({
		runId: "run-1",
		task: recipe.name,
		host: "packages/playground",
		input: "what is a fireside?",
		system: recipe.instructions,
		tools: recipe.tools,
		...(recipe.ending === undefined ? {} : { ending: recipe.ending }),
		model,
		storage,
		clock,
		ids: counterIds(),
	});

	expect(result).toMatchObject({ reason: "done", turns: 1 });
	const saved = await storage.read();
	const record = saved.ok ? saved.value.join("\n") : "";
	expect(record).toContain("A chair by the fire");
	// Nothing nudged the model, so the page has no stuck conversation to explain.
	expect(record).not.toContain("reminder");
});

test("PGS48 a conversation can call a tool and still answer in its own words", async () => {
	const recipe = chatRecipe({ clock });
	const storage = memoryStorage();
	const model = scriptedModel(
		[
			{ toolCalls: [{ id: "c1", name: "now", args: {} }] },
			{ text: "It is the hour the clock says, which is all a playground has." },
		],
		{ clock },
	);

	const result = await runTask({
		runId: "run-1",
		task: recipe.name,
		host: "packages/playground",
		input: "what time is it?",
		system: recipe.instructions,
		tools: recipe.tools,
		...(recipe.ending === undefined ? {} : { ending: recipe.ending }),
		model,
		storage,
		clock,
		ids: counterIds(),
	});

	// The call runs and the reply after it is the answer: the tool is a step inside the
	// conversation rather than a second thing to finish with.
	expect(result).toMatchObject({ reason: "done", turns: 2 });
	const saved = await storage.read();
	const record = saved.ok ? saved.value.join("\n") : "";
	expect(record).toContain(new Date(FAKE_CLOCK_START).toISOString());
	expect(record).not.toContain("reminder");
});
