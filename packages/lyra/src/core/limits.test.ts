import fc from "fast-check";
import { expect, test } from "vitest";

import {
	createFinishTool,
	toolReturning,
	toolTakingTime,
	type ScriptedTurn,
} from "../testkit/index.js";
import type { Limits } from "./limits.js";
import type { Usage } from "./model.js";
import {
	drive,
	readRecord,
	runHarness as harness,
	type RunHarness,
} from "./run-harness.testing.js";

/** The rows are in `docs/limits-and-interruptions.md`, "Rows (step 2, slice 2)". */

const readTurns = (count: number): ScriptedTurn[] =>
	Array.from({ length: count }, (_unused, index) => ({
		toolCalls: [{ id: `c${index}`, name: "read", args: {} }],
	}));

const readAndFinish = (): ScriptedTurn[] => [
	...readTurns(1),
	{ toolCalls: [{ id: "finish", name: "finish" }] },
];

/** What a limit park looks like wherever it happens (LIM01). */
async function expectParkedByLimit(
	limited: RunHarness,
	detail: string,
	askedTurns: number,
): Promise<void> {
	const record = await readRecord(limited.storage);
	expect(record.notes).toEqual([]);
	expect(record.entries.at(-1)).toMatchObject({
		type: "status",
		state: "parked",
		reason: "limit",
		detail,
	});
	// The work already done is kept, not thrown away (decision 22).
	expect(record.entries.some((entry) => entry.type === "tool_message")).toBe(true);

	const ends = limited.events.filter((event) => event.type === "run_end");
	expect(ends).toHaveLength(1);
	expect(ends[0]).toMatchObject({ reason: "parked", parkedReason: "limit", detail });
	expect(limited.events.at(-1)?.type).toBe("run_end");

	// The limit is checked before the request it would have paid for.
	expect(limited.model.requests).toHaveLength(askedTurns);
}

test("LIM01 a step limit parks the run with detail steps", async () => {
	const limited = harness(readAndFinish(), () => [
		toolReturning("read", "content"),
		createFinishTool(),
	]);

	const result = await limited.run({ limits: { steps: 1 } });
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "steps",
		turns: 1,
	});
	await expectParkedByLimit(limited, "steps", 1);
});

test("LIM01 a token limit parks the run with detail tokens", async () => {
	const limited = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "read", args: {} }],
				usage: { inputTokens: 10, outputTokens: 5 },
			},
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	// Input plus output reaches the limit exactly, which is enough to stop.
	const result = await limited.run({ limits: { tokens: 15 } });
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "tokens",
	});
	await expectParkedByLimit(limited, "tokens", 1);
});

test("LIM01 a time limit parks the run with detail time", async () => {
	const limited = harness(
		[
			{ toolCalls: [{ id: "c1", name: "slow", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		(clock) => [toolTakingTime("slow", 200, clock), createFinishTool()],
	);

	const result = await drive(limited.clock, limited.run({ limits: { timeMs: 150 } }));
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "time",
	});
	await expectParkedByLimit(limited, "time", 1);
});

test("LIM01 a cost limit parks the run with detail cost", async () => {
	const limited = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "read", args: {} }],
				usage: {
					inputTokens: 5,
					outputTokens: 5,
					cost: { amount: 0.6, currency: "USD", source: "provider" },
				},
			},
			{ toolCalls: [{ id: "c2", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	const result = await limited.run({ limits: { cost: 0.5 } });
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "cost",
	});
	await expectParkedByLimit(limited, "cost", 1);
});

test("LIM02 a run that finishes on its last allowed turn is done", async () => {
	const exact = harness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	const result = await exact.run({ limits: { steps: 3 } });
	expect(result).toMatchObject({ reason: "done", turns: 3 });
	expect(exact.model.requests).toHaveLength(3);
});

test("LIM02 a run that needs one more turn parks on the step limit", async () => {
	const short = harness(
		[
			{ toolCalls: [{ id: "c1", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c2", name: "read", args: {} }] },
			{ toolCalls: [{ id: "c3", name: "finish" }] },
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	const result = await short.run({ limits: { steps: 2 } });
	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "steps",
		turns: 2,
	});
	expect(short.model.requests).toHaveLength(2);
});

test("LIM02 a run that needs fewer turns than allowed finishes untouched", async () => {
	const roomy = harness(readAndFinish(), () => [
		toolReturning("read", "content"),
		createFinishTool(),
	]);

	const result = await roomy.run({ limits: { steps: 3 } });
	expect(result).toMatchObject({ reason: "done", turns: 2 });
});

test("LIM03 a limit that is not a positive number fails as bad_request and saves nothing", async () => {
	const cases: Limits[] = [
		{ steps: 0 },
		{ steps: -1 },
		{ steps: 1.5 },
		{ steps: Number.NaN },
		{ tokens: 0 },
		{ tokens: -5 },
		{ timeMs: 0 },
		{ timeMs: Number.POSITIVE_INFINITY },
		{ cost: 0 },
		{ cost: -0.1 },
	];

	for (const limits of cases) {
		const refused = harness([{ toolCalls: [{ id: "c1", name: "finish" }] }], () => [
			createFinishTool(),
		]);
		const result = await refused.run({ limits });

		expect(result.reason).toBe("failed");
		expect(result.reason === "failed" ? result.error?.code : "").toBe("bad_request");
		// Nothing is written, so there is no record that looks like a run.
		expect(refused.storage.saved()).toEqual([]);
		expect(refused.model.requests).toHaveLength(0);
		expect(refused.events.filter((event) => event.type === "run_end")).toHaveLength(1);
		expect(refused.events.at(-1)?.type).toBe("run_end");
	}
});

test("LIM04 the time limit counts a model call's time on the fake clock", async () => {
	const script: ScriptedTurn[] = [
		{ toolCalls: [{ id: "c1", name: "read", args: {} }], delayMs: 5_000 },
		{ toolCalls: [{ id: "c2", name: "finish" }] },
	];

	// The same script under a limit above the elapsed time continues, so the row
	// is measuring the time rather than always parking.
	const roomy = harness(script, () => [toolReturning("read", "content"), createFinishTool()]);
	const done = await drive(roomy.clock, roomy.run({ limits: { timeMs: 60_000 } }));
	expect(done).toMatchObject({ reason: "done", turns: 2 });

	const limited = harness(script, () => [toolReturning("read", "content"), createFinishTool()]);
	const started = limited.clock.now();
	const result = await drive(limited.clock, limited.run({ limits: { timeMs: 4_000 } }));

	expect(result).toMatchObject({
		reason: "parked",
		parkedReason: "limit",
		parkedDetail: "time",
	});
	expect(limited.model.requests).toHaveLength(1);
	// The model's five seconds were moved by the fake clock, and nothing waited.
	expect(limited.clock.now() - started).toBeGreaterThanOrEqual(5_000);
	expect(limited.clock.pending()).toBe(0);
});

test("LIM05 a cost limit with no reported cost writes one note and carries on", async () => {
	const uncosted = harness(
		[
			{
				toolCalls: [{ id: "c1", name: "read", args: {} }],
				usage: { inputTokens: 4, outputTokens: 6 },
			},
			{
				toolCalls: [{ id: "c2", name: "finish" }],
				usage: { inputTokens: 2, outputTokens: 3 },
			},
		],
		() => [toolReturning("read", "content"), createFinishTool()],
	);

	const result = await uncosted.run({ limits: { cost: 0.5 } });
	// A limit that cannot be measured is not a reason to stop the work.
	expect(result.reason).toBe("done");

	const record = await readRecord(uncosted.storage);
	expect(record.notes).toEqual([]);
	const notes = record.entries.filter((entry) => entry.type === "note");
	// One note for the run, not one per reply that omitted a cost.
	expect(notes).toHaveLength(1);
	expect(notes[0]).toMatchObject({ type: "note", kind: "limit_unenforceable" });
	expect(result.usage.cost).toBeUndefined();
});

const usageArbitrary: fc.Arbitrary<Usage> = fc
	.record({
		inputTokens: fc.nat({ max: 1_000 }),
		outputTokens: fc.nat({ max: 1_000 }),
		cost: fc.option(
			fc.record({
				amount: fc.nat({ max: 100 }),
				source: fc.constantFrom("provider", "allowance", "catalog"),
			}),
			{ nil: undefined },
		),
	})
	.map(({ cost, ...rest }) =>
		cost === undefined ? rest : { ...rest, cost: { ...cost, currency: "USD" as const } },
	);

const scriptArbitrary = fc
	.array(usageArbitrary, { minLength: 1, maxLength: 4 })
	.chain((usages) =>
		fc.integer({ min: 0, max: usages.length - 1 }).map((failAt) => ({ usages, failAt })),
	);

/** The cost total the run should report for the replies that arrived (LOOP03's rule). */
function expectedCost(replies: Usage[]): Usage["cost"] {
	const first = replies[0]?.cost;
	if (first === undefined) {
		return undefined;
	}
	if (!replies.every((reply) => reply.cost?.source === first.source)) {
		return undefined;
	}
	return {
		amount: replies.reduce((total, reply) => total + (reply.cost?.amount ?? 0), 0),
		currency: "USD",
		source: first.source,
	};
}

test("LIM07 the usage total is the sum of the replies that arrived, even after a failure", async () => {
	await fc.assert(
		fc.asyncProperty(scriptArbitrary, async ({ usages, failAt }) => {
			const turns: ScriptedTurn[] = usages.map((usage, index) =>
				index === failAt
					? { failures: [{ code: "provider_error", retryable: false }] }
					: { toolCalls: [{ id: `c${index}`, name: "read", args: {} }], usage },
			);
			const failing = harness(turns, () => [
				toolReturning("read", "content"),
				createFinishTool(),
			]);

			const result = await failing.run();
			const arrived = usages.slice(0, failAt);

			expect(result.reason).toBe("failed");
			expect(result.turns).toBe(failAt + 1);
			expect(result.usage.inputTokens).toBe(
				arrived.reduce((total, usage) => total + usage.inputTokens, 0),
			);
			expect(result.usage.outputTokens).toBe(
				arrived.reduce((total, usage) => total + usage.outputTokens, 0),
			);
			expect(result.usage.cost).toEqual(expectedCost(arrived));

			const record = await readRecord(failing.storage);
			expect(record.notes).toEqual([]);
			expect(failing.events.filter((event) => event.type === "run_end")).toHaveLength(1);
			expect(failing.events.at(-1)?.type).toBe("run_end");
		}),
	);
});
