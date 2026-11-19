/**
 * A run's wake as a Durable Object alarm (docs/adapters.md, CFL07 to CFL13; decisions
 * 72 and 101).
 *
 * One alarm per object and one run active per session, so one row is enough: which
 * run to wake, and when. `schedule` replaces the row and the alarm (Cloudflare keeps
 * one alarm and `setAlarm` replaces it), and `cancel` removes both. The host's
 * `alarm()` reads the row and calls `runtime.wake`, whose own registry is what makes
 * a late, duplicated or concurrent alarm harmless.
 *
 * An alarm is delivered at least once and retried if the handler throws, so the
 * host's handler must catch everything: a domain failure is a reason not to wake a
 * run, not a reason to have Cloudflare try again forever.
 *
 * The types are structural and local, like the storage adapter's, so the core's
 * program never learns a Workers global.
 */

import type { WakingSlot } from "../../core/slots.js";
import type { DurableObjectSqlStorage } from "./storage.js";

/** What this adapter needs from `DurableObjectStorage`'s alarm surface. */
export interface DurableObjectAlarmStorage extends DurableObjectSqlStorage {
	getAlarm(): Promise<number | null>;
	setAlarm(scheduledTime: number | Date): Promise<void>;
	deleteAlarm(): Promise<void>;
}

/** The one row: which run, and when it was due. */
export interface ScheduledWake {
	runId: string;
	atMs: number;
}

const CREATE =
	"CREATE TABLE IF NOT EXISTS lyra_wake (id INTEGER PRIMARY KEY CHECK (id = 0), run_id TEXT NOT NULL, at_ms INTEGER NOT NULL)";

function ensureTable(storage: DurableObjectSqlStorage): void {
	storage.sql.exec(CREATE);
}

/** The wake this object holds, or nothing when it holds none. */
export async function scheduledWake(
	storage: DurableObjectSqlStorage,
): Promise<ScheduledWake | undefined> {
	ensureTable(storage);
	const rows = storage.sql.exec("SELECT run_id, at_ms FROM lyra_wake WHERE id = 0").toArray();
	const row = rows[0];
	if (row === undefined) {
		return undefined;
	}
	const runId = row["run_id"];
	const atMs = row["at_ms"];
	if (typeof runId !== "string" || typeof atMs !== "number") {
		return undefined;
	}
	return { runId, atMs };
}

export function alarmWaking(storage: DurableObjectAlarmStorage): WakingSlot {
	return {
		async schedule(runId: string, atMs: number): Promise<void> {
			storage.transactionSync(() => {
				ensureTable(storage);
				storage.sql.exec("DELETE FROM lyra_wake");
				storage.sql.exec(
					"INSERT INTO lyra_wake (id, run_id, at_ms) VALUES (0, ?, ?)",
					runId,
					atMs,
				);
			});
			// The row is the truth; the alarm is when it will be read. Set it after the
			// row so an alarm that fires immediately finds something to wake.
			await storage.setAlarm(atMs);
		},

		async cancel(runId: string): Promise<void> {
			// One run per session, so the row can only be this run's; the parameter is
			// part of the slot's shape rather than something to match on. A cancel for
			// a run the object no longer holds still clears the alarm, which is the
			// harmless direction.
			void runId;
			storage.transactionSync(() => {
				ensureTable(storage);
				storage.sql.exec("DELETE FROM lyra_wake");
			});
			await storage.deleteAlarm();
		},
	};
}
