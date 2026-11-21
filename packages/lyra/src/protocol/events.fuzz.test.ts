import fc from "fast-check";
import { expect, test } from "vitest";

import { entriesArbitrary } from "../record/generators.testing.js";
import { eventsAfter, projectEvents } from "./events.js";

/**
 * EVT01 in `docs/protocol.md`. The projection is the only thing a reconnecting
 * client reads its history from, so it has to be faithful to any record the format
 * allows, including one a damaged host left odd: every event names the entry it
 * came from, no ending is invented or dropped, and a replay from a `seq` is the
 * suffix a client missed, never half an entry.
 */

const context = { session: "s1", run: "r1" };

test("EVT01 any record projects into ordered events that end where the record does", () => {
	fc.assert(
		fc.property(entriesArbitrary(), fc.nat({ max: 20 }), (entries, cut) => {
			const projected = projectEvents(entries, context);

			// Each event names an entry that exists, and carries that entry's time.
			for (const event of projected) {
				const entry = entries[event.seq];
				expect(entry).toBeDefined();
				expect(event.ts).toBe(entry?.ts);
				expect(event.session).toBe(context.session);
				expect(event.run).toBe(context.run);
			}
			// Positions never go backwards, so a client can resume from one.
			const seqs = projected.map((event) => event.seq);
			expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

			// A run ends once per terminal status, and nowhere else, so a projection
			// never invents an ending and never hides one.
			const terminals = entries.flatMap((entry, index) =>
				entry.type === "status" &&
				(entry.state === "done" || entry.state === "failed" || entry.state === "parked")
					? [{ index, state: entry.state }]
					: [],
			);
			const ends = projected.filter((event) => event.type === "run_end");
			expect(ends.map((event) => event.seq)).toEqual(
				terminals.map((terminal) => terminal.index),
			);
			expect(ends.map((event) => (event.type === "run_end" ? event.reason : ""))).toEqual(
				terminals.map((terminal) =>
					terminal.state === "parked" ? "parked" : terminal.state,
				),
			);

			// A replay is the suffix a client missed, and the events of one entry are
			// delivered together: a `seq` at or before the cut is never partly sent.
			expect(eventsAfter(projected, cut)).toEqual(
				projected.filter((event) => event.seq > cut),
			);
		}),
		{ numRuns: 300 },
	);
});

test("EVT01 a record with no ending never ends the run early", () => {
	const projected = projectEvents(
		[
			{
				type: "assistant_message",
				id: "e0",
				parent: null,
				ts: 1,
				text: "",
				toolCalls: [],
				model: "m",
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: "stop",
			},
		],
		context,
	);
	expect(projected.filter((event) => event.type === "run_end")).toEqual([]);
	expect(projected).toHaveLength(3);
});
