import { expect, test } from "vitest";

import { counterIds } from "../adapters/memory/ids.js";
import { memoryStorage } from "../adapters/memory/storage.js";
import type { RunEvent } from "../core/events.js";
import { runTask } from "../core/run.js";
import { loadRecord } from "../record/load.js";
import { fakeClock } from "./clock.js";
import { misbehavingModel, misbehavingScript, MISBEHAVING_KINDS } from "./misbehaving-model.js";
import { createFinishTool } from "./tools.js";

/**
 * The model that is wrong on purpose (docs/engineering-practices.md, KIT12 and
 * KIT13; decision 64). The point is not any single wrong reply: it is that a run
 * in front of one still ends exactly once, with a record that loads.
 */

test("KIT12 one seed draws one script, and it is made of the wrong kinds it names", () => {
	const script = misbehavingScript(7, { turns: 40 });
	expect(script).toHaveLength(40);
	for (const entry of script) {
		expect(MISBEHAVING_KINDS).toContain(entry.turn);
	}
	// The draw is deterministic, which is what makes a failure repeatable.
	expect(misbehavingScript(7, { turns: 40 })).toEqual(script);
	// And it is not the same script for every seed.
	expect(misbehavingScript(8, { turns: 40 })).not.toEqual(script);
});

test("KIT12 the script really does the wrong thing it says", () => {
	const kinds = new Set(MISBEHAVING_KINDS);
	const seen = new Set<string>();
	for (let seed = 1; seed <= 40; seed += 1) {
		for (const entry of misbehavingScript(seed, { turns: 20 })) {
			seen.add(entry.turn);
			const calls = entry.script.toolCalls ?? [];
			switch (entry.turn) {
				case "truncated":
					expect(() => JSON.parse(String(calls[0]?.args))).toThrow();
					break;
				case "unknown":
					expect(calls[0]?.name).toBe("not_a_tool");
					break;
				case "empty":
					expect(entry.script.text).toBe("");
					expect(calls).toHaveLength(0);
					break;
				case "cut-off":
					expect(entry.script.finishReason).toBe("length");
					expect(calls.length).toBeGreaterThan(0);
					break;
				case "no-cost":
					expect(entry.script.usage?.cost).toBeUndefined();
					break;
				case "done":
				case "repeat":
					break;
			}
		}
	}
	// Every kind is reachable, so none of the checks above is vacuous.
	expect([...seen].sort()).toEqual([...kinds].sort());
});

test("KIT13 every run against it ends exactly once, with a record that loads", async () => {
	for (let seed = 1; seed <= 25; seed += 1) {
		const clock = fakeClock();
		const storage = memoryStorage();
		const events: RunEvent[] = [];
		const model = misbehavingModel(seed, { clock });

		const result = await runTask({
			runId: `misbehaving-${seed}`,
			task: "misbehaving",
			host: "test-host",
			input: "finish the job",
			system: "you are being tested",
			tools: [createFinishTool()],
			model,
			storage,
			clock,
			ids: counterIds(),
			limits: { steps: 12 },
			onEvent: (event) => {
				events.push(event);
			},
		});

		const endings = events.filter((event) => event.type === "run_end");
		expect({ seed, endings: endings.length }).toEqual({ seed, endings: 1 });
		expect(events.at(-1)?.type).toBe("run_end");
		expect(["done", "parked", "failed"]).toContain(result.reason);

		const saved = await storage.read();
		expect(saved.ok).toBe(true);
		if (!saved.ok) {
			continue;
		}
		const record = loadRecord(saved.value);
		expect({ seed, loaded: record.ok, notes: record.ok ? record.value.notes : [] }).toEqual({
			seed,
			loaded: true,
			notes: [],
		});
		// The record is the run's own account of itself: it starts and it ends.
		if (record.ok) {
			expect(record.value.entries.at(-1)?.type).toBe("status");
		}
	}
});
