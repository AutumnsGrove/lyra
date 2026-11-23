import { expect } from "vitest";

import type { RecordEntry } from "../../record/entries.js";
import { entries, record } from "../../record/corpus/entries.testing.js";
import { eventsAfter, projectEvents } from "../events.js";

/**
 * The committed cases for EVT01, and the property they hold. The projection is the
 * only thing a reconnecting client reads its history from, so it has to be faithful
 * to any record the format allows: a run that ended, one that parked, one with no
 * ending at all, and a replay from a `seq` in the middle.
 *
 * The property lives here so the generator in `events.fuzz.test.ts` and the replay
 * in `corpus/events.test.ts` share one definition (issue #41).
 */

const context = { session: "s1", run: "r1" };

/** `[the record's entries, the `seq` a client reconnects from]`. */
export type EventsCase = readonly [readonly RecordEntry[], number];

export const cases: Readonly<Record<string, EventsCase>> = {
	"a-whole-run-that-ended": [record, 0],
	"a-reconnect-from-the-middle": [record, 3],
	"a-record-with-no-ending": [
		[entries["a-user-message"], entries["an-assistant-message-with-two-calls"]],
		0,
	],
	"a-run-that-parked": [[entries["a-user-message"], entries["a-parked-status"]], 0],
	"an-empty-record": [[], 0],
};

/**
 * The property, shared by the generator and the replay: every event names the entry
 * it came from, no ending is invented or dropped, and a replay from a `seq` is the
 * suffix a client missed.
 */
export function holds([entriesInRecord, cut]: EventsCase): void {
	const projected = projectEvents(entriesInRecord, context);

	// Each event names an entry that exists, and carries that entry's time.
	for (const event of projected) {
		const entry = entriesInRecord[event.seq];
		expect(entry).toBeDefined();
		expect(event.ts).toBe(entry?.ts);
		expect(event.session).toBe(context.session);
		expect(event.run).toBe(context.run);
	}
	// Positions never go backwards, so a client can resume from one.
	const seqs = projected.map((event) => event.seq);
	expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);

	// A run ends once per terminal status, and nowhere else, so a projection never
	// invents an ending and never hides one.
	const terminals = entriesInRecord.flatMap((entry, index) =>
		entry.type === "status" &&
		(entry.state === "done" || entry.state === "failed" || entry.state === "parked")
			? [{ index, state: entry.state }]
			: [],
	);
	const ends = projected.filter((event) => event.type === "run_end");
	expect(ends.map((event) => event.seq)).toEqual(terminals.map((terminal) => terminal.index));
	expect(ends.map((event) => (event.type === "run_end" ? event.reason : ""))).toEqual(
		terminals.map((terminal) => (terminal.state === "parked" ? "parked" : terminal.state)),
	);

	// A replay is the suffix a client missed, and the events of one entry are
	// delivered together: a `seq` at or before the cut is never partly sent.
	expect(eventsAfter(projected, cut)).toEqual(projected.filter((event) => event.seq > cut));
}
