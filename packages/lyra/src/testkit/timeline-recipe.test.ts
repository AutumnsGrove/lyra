import { expect, test } from "vitest";

import { counterIds, memoryStorage } from "../adapters/memory/index.js";
import { crashingStorage, fakeClock, scriptedModel, type ScriptedTurn } from "../testkit/index.js";
import { runTask, type RunConfig } from "../core/run.js";
import { until } from "../core/run-harness.testing.js";
import {
	renderHandles,
	renderPage,
	timelineTestRecipe,
	type TimelineState,
} from "./timeline-recipe.js";

/** The row is RSM07 in `docs/limits-and-interruptions.md`. */

const DAY = {
	repos: ["lattice", "lyra"],
	commits: [
		{ repo: "lattice", sha: "abc123", message: "Fix the thing" },
		{ repo: "lyra", sha: "def456", message: "Write the docs" },
	],
};

const turns: ScriptedTurn[] = [
	{ toolCalls: [{ id: "t1", name: "start_project", args: { repo: "lattice" } }] },
	{
		toolCalls: [
			{
				id: "t2",
				name: "add_line",
				args: { project: "lattice", text: "Fixed the thing", cites: ["c1"] },
			},
		],
	},
	{ toolCalls: [{ id: "t3", name: "start_project", args: { repo: "lyra" } }] },
	{
		toolCalls: [
			{
				id: "t4",
				name: "add_line",
				args: { project: "lyra", text: "Wrote the docs", cites: ["c2"] },
			},
		],
	},
	{
		toolCalls: [
			{ id: "t5", name: "add_vine", args: { line: "l1", text: "finally, the loop works" } },
		],
	},
	{ toolCalls: [{ id: "t6", name: "finish", args: {} }] },
];

const PAGE = [
	"## lattice",
	"- l1 Fixed the thing [c1]",
	"## lyra",
	"- l2 Wrote the docs [c2]",
	"* l1: finally, the loop works",
].join("\n");

function base(clock: ReturnType<typeof fakeClock>): Omit<RunConfig, "model" | "storage"> {
	const setup = timelineTestRecipe.setup;
	if (setup === undefined) {
		throw new Error("the test recipe has no setup");
	}
	return {
		runId: "run-1",
		task: "timeline-test",
		host: "test-host",
		input: "",
		inputValue: DAY,
		setup,
		system: timelineTestRecipe.instructions,
		tools: [...timelineTestRecipe.tools],
		clock,
		ids: counterIds(),
	};
}

test("RSM07 the test recipe builds a page a person can read", async () => {
	const clock = fakeClock();
	const storage = memoryStorage();
	const result = await runTask({
		...base(clock),
		model: scriptedModel(turns, { clock }),
		storage,
	});

	expect(result.reason).toBe("done");
	const state = result.state as TimelineState;
	expect(renderPage(state)).toBe(PAGE);
	expect(renderHandles(state)).toBe("c1, c2");
	expect(state.handles.resolve("c1")).toEqual({ repo: "lattice", sha: "abc123" });
});

test("RSM07 killed at every append, the resumed page and handles are the uninterrupted ones", async () => {
	const count = await (async () => {
		const clock = fakeClock();
		const storage = memoryStorage();
		await runTask({
			...base(clock),
			model: scriptedModel(turns, { clock }),
			storage,
		});
		return storage.saved().length;
	})();
	expect(count).toBeGreaterThan(5);

	// The first append is the header; a record with nothing else cannot be resumed.
	for (let at = 2; at <= count; at += 1) {
		for (const when of ["before", "after"] as const) {
			const clock = fakeClock();
			const inner = memoryStorage();
			const dying = crashingStorage(inner, { at, when });
			void runTask({
				...base(clock),
				model: scriptedModel(turns, { clock }),
				storage: dying,
			});
			await until(() => dying.appends() >= at);
			for (let tick = 0; tick < 20; tick += 1) {
				await Promise.resolve();
			}
			const read = await inner.read();
			expect(read.ok).toBe(true);
			const lines = read.ok ? read.value : [];

			const resumed = await runTask({
				...base(clock),
				model: scriptedModel(turns, { clock }),
				storage: inner,
				resume: { lines, by: "person" },
			});
			const where = `killed at append ${at} ${when}`;
			if (at === 2 && when === "before") {
				// The header landed and the task message did not, so the record has no
				// input to run `setup` again with. Inventing one would invent the page,
				// so this one window fails and says why (decision 112).
				expect(resumed.reason).toBe("failed");
				expect(resumed.error?.message).toContain("no task input");
				continue;
			}
			expect(`${where}: ${resumed.reason} ${resumed.error?.message ?? ""}`).toBe(
				`${where}: done `,
			);
			const state = resumed.state as TimelineState;
			expect(`${where}: ${renderPage(state)}`).toBe(`${where}: ${PAGE}`);
			expect(`${where}: ${renderHandles(state)}`).toBe(`${where}: c1, c2`);
		}
	}
});

test("RSM07 a repeated add_line after a resume adds exactly one line", async () => {
	// Kill once the first line's own result is saved: the resume replays it through
	// apply, and the repeated call key must not add a second l1.
	const clock = fakeClock();
	const inner = memoryStorage();
	const dying = crashingStorage(inner, { at: 7, when: "before" });
	void runTask({ ...base(clock), model: scriptedModel(turns, { clock }), storage: dying });
	await until(() => dying.appends() >= 7);
	for (let tick = 0; tick < 20; tick += 1) {
		await Promise.resolve();
	}
	const read = await inner.read();
	const lines = read.ok ? read.value : [];

	const resumed = await runTask({
		...base(clock),
		model: scriptedModel(turns, { clock }),
		storage: inner,
		resume: { lines, by: "person" },
	});
	const state = resumed.state as TimelineState;
	expect(renderPage(state).match(/- l1 /g)).toHaveLength(1);
	expect(renderPage(state)).toBe(PAGE);
});
