/**
 * Limits (docs/limits-and-interruptions.md, LIM01 to LIM05 and LIM07; decisions
 * 18 and 22).
 *
 * Every limit is optional and there is none by default. Reaching one parks the run
 * rather than killing it, so the work done so far is kept and a person can resume
 * it with a larger allowance. The check happens before each model request, which
 * is the only place a run can pause without cutting a step in half.
 *
 * Time is active time, measured from a status on the injected clock, so a parked
 * run costs nothing. A cost limit counts reported cost of any source; when a reply
 * reports none the total is understated, so the limit stops being enforced for the
 * run and the record says so once (decision 15).
 */

import { fail, ok, type Result } from "./result.js";

export interface Limits {
	/** Model turns. `3` allows three requests, and a run that ends on its third is done. */
	steps?: number;
	/** Input plus output tokens summed over the replies that arrived. */
	tokens?: number;
	/** Active milliseconds since the run's latest `running` or `resumed` status. */
	timeMs?: number;
	/** Reported cost, summed over the replies, whatever its source. */
	cost?: number;
}

/** Which limit stopped a run, as the parked status says it. */
export type LimitDetail = "steps" | "tokens" | "time" | "cost";

/**
 * The order limits are checked in, and so the one named when several are reached
 * at once. It is fixed rather than incidental so the same state always writes the
 * same detail.
 */
export const LIMIT_DETAILS: readonly LimitDetail[] = ["steps", "tokens", "time", "cost"];

/** What a run has used so far, which is what a limit is compared against. */
export interface LimitProgress {
	/** Model requests already made. */
	turns: number;
	tokens: number;
	/** The reported cost so far, and whether every reply reported one. */
	cost: { amount: number; known: boolean };
	activeMs: number;
}

/**
 * A positive whole number, which is what a limit and a cap both have to be. It is
 * exported because the parallel cap is checked in three places (a recipe when it is
 * defined, a hand-built run's fallback, and the executor's chunk size), and three
 * copies of the rule is two chances for them to disagree.
 */
export function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPositiveNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * A limit a recipe set, checked once when the run is created so a bad config fails
 * fast instead of parking a run before it does anything (LIM03).
 */
export function validateLimits(limits: Limits): Result<Limits> {
	const checked: Limits = {};
	if (limits.steps !== undefined) {
		if (!isPositiveInteger(limits.steps)) {
			return fail("bad_request", "a limit's steps must be a positive whole number");
		}
		checked.steps = limits.steps;
	}
	if (limits.tokens !== undefined) {
		if (!isPositiveInteger(limits.tokens)) {
			return fail("bad_request", "a limit's tokens must be a positive whole number");
		}
		checked.tokens = limits.tokens;
	}
	if (limits.timeMs !== undefined) {
		if (!isPositiveInteger(limits.timeMs)) {
			return fail("bad_request", "a limit's timeMs must be a positive whole number");
		}
		checked.timeMs = limits.timeMs;
	}
	if (limits.cost !== undefined) {
		if (!isPositiveNumber(limits.cost)) {
			return fail("bad_request", "a limit's cost must be a positive number");
		}
		checked.cost = limits.cost;
	}
	return ok(checked);
}

/** The first limit the run has reached, or nothing when it may keep going (LIM01). */
export function reachedLimit(
	limits: Limits | undefined,
	progress: LimitProgress,
): LimitDetail | undefined {
	if (limits === undefined) {
		return undefined;
	}
	if (limits.steps !== undefined && progress.turns >= limits.steps) {
		return "steps";
	}
	if (limits.tokens !== undefined && progress.tokens >= limits.tokens) {
		return "tokens";
	}
	if (limits.timeMs !== undefined && progress.activeMs >= limits.timeMs) {
		return "time";
	}
	// An unmeasurable cost total is not a limit: the run notes it and carries on
	// rather than pretending the limit works (LIM05).
	if (limits.cost !== undefined && progress.cost.known && progress.cost.amount >= limits.cost) {
		return "cost";
	}
	return undefined;
}
