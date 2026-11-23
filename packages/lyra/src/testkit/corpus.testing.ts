import fc from "fast-check";

/**
 * The committed corpus for the fuzz targets (issue #41).
 *
 * A fuzz target draws fresh cases from a generator every time, so it keeps
 * nothing: an input that failed last week no longer exists anywhere, and nothing
 * replays it. A committed case is a regression test with a bad memory. It runs in
 * the gate, next to the generator, and it runs whether or not the generator
 * happens to visit that shape again.
 *
 * Two rules this file enforces, both learned from what goes wrong:
 *
 * - **An empty corpus is a failure.** A corpus that exists and holds nothing
 *   would make `replay` a test that cannot fail, which is the same as no test.
 * - **A printed case is the shrunk one.** A case copied from the first random
 *   failure is unreadable; fast-check shrinks to the smallest input that still
 *   fails, and that is the one worth writing down.
 *
 * Cases live beside their target as a `.testing.ts` module rather than JSON, so
 * the shape of a case is checked by the compiler: a case with the wrong fields is
 * a type error, not a mystery at run time.
 *
 * Nothing here writes to the tree. A test that writes into `src/` leaves a dirty
 * worktree and races with a parallel worker, so a failing generated case is
 * printed ready to paste into the corpus file, and the nightly workflow's log is
 * the artifact that carries it.
 */

export type Cases<T> = Readonly<Record<string, T>>;

export interface GenerateOptions {
	/** How many cases to draw. The fuzz config gives the test 60 s on purpose. */
	numRuns: number;
}

/**
 * Run every committed case through the same `holds` the generator uses, so the
 * corpus cannot drift into testing something the property no longer says.
 */
export function replay<T>(target: string, cases: Cases<T>, holds: (value: T) => void): void {
	const names = Object.keys(cases);
	if (names.length === 0) {
		throw new Error(
			`${target} has no cases: a corpus with nothing in it is a test that cannot fail`,
		);
	}
	for (const name of names) {
		const value = cases[name];
		if (value === undefined) {
			continue;
		}
		try {
			holds(value);
		} catch (cause) {
			const reason = cause instanceof Error ? cause.message : String(cause);
			throw new Error(`${target} case "${name}" no longer holds: ${reason}`, { cause });
		}
	}
}

/**
 * Run the generator, and on failure hand back the shrunk case in a form that can
 * be pasted into the target's corpus file.
 *
 * `fc.check` rather than `fc.assert` because the assertion's message is written
 * for a person reading a failure, and what is needed here is the case itself.
 * The case goes into the thrown error's message rather than a log: the core has
 * no console on purpose (logging is injected), and the failure message is where
 * somebody looks anyway. The nightly workflow keeps the log, so the case travels
 * with the red run (issue #41).
 */
export function generate<T>(
	target: string,
	arbitrary: fc.Arbitrary<T>,
	holds: (value: T) => void,
	options: GenerateOptions,
): void {
	const details = fc.check(fc.property(arbitrary, holds), { numRuns: options.numRuns });
	if (!details.failed) {
		return;
	}
	// `counterexample` is the list of arguments fast-check handed the property, not
	// the case itself: a property here takes exactly one arbitrary, so the case is
	// its only element. Printing the list nested every pasted case one level deeper,
	// which is a type error for a typed corpus and a silently wrong replay for an
	// `unknown` one (found in review).
	const only = details.counterexample?.[0];
	const smallest =
		only === undefined ? "(none: it failed without a case)" : JSON.stringify(only, null, 2);
	throw new Error(
		[
			`${target} found a failing case. Add this to ${target}'s corpus file:`,
			smallest,
			`(seed ${details.seed}, ${details.numRuns} runs)`,
		].join("\n"),
		{ cause: details.errorInstance },
	);
}
