/**
 * Adding up what a run spent (docs/limits-and-retries.md, LIM05; decision 15).
 *
 * Tokens always add up. A cost total only means something when every reply
 * reported one, from the same kind of billing, so one reply without a cost drops
 * the total for the run instead of reporting a number that is too low.
 *
 * A cost *limit* is different: it compares against every amount reported, whatever
 * its source, and it is unenforceable as soon as one reply reports none, because
 * the total is then understated.
 *
 * The live loop and the protocol's replay both use this, so a `run_end` read from
 * a record reports the same total the run itself did.
 */

import type { Usage } from "./model.js";

export interface UsageTotal {
	add(next: Usage): void;
	/** What the run has used so far, with a cost only when every reply reported one. */
	total(): Usage;
	tokens(): number;
	costSpent(): { amount: number; known: boolean };
}

export function createUsageTotal(): UsageTotal {
	let inputTokens = 0;
	let outputTokens = 0;
	let cost: Usage["cost"] | undefined;
	let costKnown = true;
	let spent = 0;
	let everyCostReported = true;

	return {
		add(next: Usage): void {
			inputTokens += next.inputTokens;
			outputTokens += next.outputTokens;
			if (next.cost === undefined) {
				everyCostReported = false;
			} else {
				spent += next.cost.amount;
			}
			if (!costKnown) {
				return;
			}
			if (next.cost === undefined) {
				costKnown = false;
			} else if (cost === undefined) {
				cost = next.cost;
			} else if (cost.source === next.cost.source) {
				cost = {
					amount: cost.amount + next.cost.amount,
					currency: "USD",
					source: cost.source,
				};
			} else {
				costKnown = false;
			}
		},

		total(): Usage {
			const sum: Usage = { inputTokens, outputTokens };
			if (costKnown && cost !== undefined) {
				sum.cost = cost;
			}
			return sum;
		},

		tokens(): number {
			return inputTokens + outputTokens;
		},

		costSpent(): { amount: number; known: boolean } {
			return { amount: spent, known: everyCostReported };
		},
	};
}
