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
 * Three rules this file enforces, each learned from what goes wrong:
 *
 * - **An empty corpus is a failure.** A corpus that exists and holds nothing
 *   would make `replay` a test that cannot fail, which is the same as no test.
 * - **A printed case is the shrunk one.** A case copied from the first random
 *   failure is unreadable; fast-check shrinks to the smallest input that still
 *   fails, and that is the one worth writing down.
 * - **A printed case is the case.** `JSON.stringify` is lossy exactly where the
 *   generators reach: `NaN`, `Infinity` and `-0` become `null` or `0`, keys holding
 *   `undefined` disappear, and a `bigint` throws. A case printed that way replays a
 *   different input, and may pass. `fc.stringify` prints a JavaScript value, which
 *   is what a corpus module holds (found in review).
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
	// `Object.entries` rather than indexing, because a case whose value is literally
	// `undefined` is a case: indexing makes it indistinguishable from a missing key,
	// and the old skip ran nothing for it (found in review). `decode-reply` stores
	// `unknown` and its generator draws `fc.constant(undefined)`, so it is reachable.
	for (const [name, value] of Object.entries(cases)) {
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
	//
	// `fc.stringify` rather than `JSON.stringify`, because the generators reach for
	// values JSON cannot carry (`fc.double()` makes `NaN`, `fc.constant(undefined)`
	// makes a missing key) and a lossy case is a case that may pass.
	const smallest =
		details.counterexample === null
			? "(none: it failed without a case)"
			: fc.stringify(details.counterexample[0]);
	throw new Error(
		[
			`${target} found a failing case. Add this to ${target}'s corpus file:`,
			smallest,
			`(seed ${details.seed}, ${details.numRuns} runs)`,
		].join("\n"),
		{ cause: details.errorInstance },
	);
}
