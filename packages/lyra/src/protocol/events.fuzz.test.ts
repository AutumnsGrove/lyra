import fc from "fast-check";
import { expect, test } from "vitest";

import { entriesArbitrary } from "../record/generators.testing.js";
import { generate } from "../testkit/corpus.testing.js";
import { holds } from "./corpus/events.testing.js";
import { projectEvents } from "./events.js";

/**
 * EVT01 in `docs/protocol.md`. The projection is the only thing a reconnecting
 * client reads its history from, so it has to be faithful to any record the format
 * allows, including one a damaged host left odd: every event names the entry it
 * came from, no ending is invented or dropped, and a replay from a `seq` is the
 * suffix a client missed, never half an entry.
 */

const context = { session: "s1", run: "r1" };

test("EVT01 any record projects into ordered events that end where the record does", () => {
	generate("events", fc.tuple(entriesArbitrary(), fc.nat({ max: 20 })), holds, { numRuns: 300 });
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
