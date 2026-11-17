/**
 * Waking, recorded instead of scheduled.
 *
 * A real host wakes a run by itself, after a wait or an interruption. A test
 * cannot wait, so this adapter keeps what would have been scheduled and lets the
 * test fire it, which is how a resumed run is exercised without time passing.
 */

import type { WakingSlot } from "../../core/slots.js";

export interface ScheduledWake {
	runId: string;
	atMs: number;
}

export interface MemoryWaking {
	slot: WakingSlot;
	/** What is waiting to fire, in the order it was scheduled. */
	scheduled(): ScheduledWake[];
	/** Take what is waiting, in order, and leave nothing behind. */
	fire(): ScheduledWake[];
}

export function memoryWaking(): MemoryWaking {
	const waiting = new Map<string, number>();

	return {
		slot: {
			async schedule(runId, atMs) {
				// One wake per run: scheduling again moves it, which is what a run that
				// parks twice expects.
				waiting.set(runId, atMs);
			},
			async cancel(runId) {
				waiting.delete(runId);
			},
		},
		scheduled: () => [...waiting].map(([runId, atMs]) => ({ runId, atMs })),
		fire() {
			const due = [...waiting].map(([runId, atMs]) => ({ runId, atMs }));
			waiting.clear();
			return due;
		},
	};
}
