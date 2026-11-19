/**
 * A run's record in a Durable Object's SQLite storage (docs/adapters.md, STO01 to
 * STO04 and CFL01 to CFL06; decisions 72 and 102).
 *
 * One row per line, in a fixed table, with `seq` as the primary key and the line
 * exactly as the core encoded it. The table is created on first use rather than at
 * construction, so a storage that is already broken comes back as a failed result
 * instead of a throwing factory.
 *
 * The types are structural and local on purpose. `DurableObjectStorage` is a
 * Workers global, and the core builds with no platform types at all; an adapter
 * that needs one global would drag it into the program that checks everything
 * else. The fixture passes the real `ctx.storage`, which satisfies this shape.
 *
 * `append` runs inside `transactionSync`, whose callback is synchronous, so two
 * appends can never interleave: the next `seq` is read and the row written before
 * the transaction ends (STO04). A transaction that throws rolls back, so a failed
 * append leaves no gap.
 */

import { fail, ok, type Result } from "../../core/result.js";
import { DEFAULT_ENTRY_CAP_BYTES } from "../../core/run.js";
import type { StorageSlot } from "../../core/slots.js";

/** One statement's rows, as the driver hands them over. */
export interface SqlCursorLike {
	toArray(): Record<string, unknown>[];
}

/** The synchronous SQLite surface a Durable Object's storage exposes. */
export interface SqlStorageLike {
	exec(query: string, ...bindings: unknown[]): SqlCursorLike;
}

/** What this adapter needs from `DurableObjectStorage`, and nothing else. */
export interface DurableObjectSqlStorage {
	readonly sql: SqlStorageLike;
	transactionSync<T>(callback: () => T): T;
}

export interface CloudflareStorageOptions {
	/**
	 * The largest line this adapter accepts, in bytes. It defaults to the record's
	 * own 1 MiB cap, which sits well under Cloudflare's 2 MB row limit, and a larger
	 * line is refused before SQLite sees it (decision 102).
	 */
	maxEntryBytes?: number;
}

const encoder = new TextEncoder();

/** UTF-8 bytes, which is what a storage limit is measured in. */
function byteLength(text: string): number {
	return encoder.encode(text).length;
}

const CREATE =
	"CREATE TABLE IF NOT EXISTS lyra_entries (seq INTEGER PRIMARY KEY, line TEXT NOT NULL)";

export function durableObjectStorage(
	storage: DurableObjectSqlStorage,
	options: CloudflareStorageOptions = {},
): StorageSlot {
	const limit = options.maxEntryBytes ?? DEFAULT_ENTRY_CAP_BYTES;
	let ready = false;

	/** Create the table once. The caller decides whether it is inside a transaction. */
	const ensureTable = (): void => {
		if (ready) {
			return;
		}
		storage.sql.exec(CREATE);
		ready = true;
	};

	const slot: StorageSlot = {
		maxEntryBytes: limit,

		async append(line: string): Promise<Result<{ seq: number }>> {
			const bytes = byteLength(line);
			if (bytes > limit) {
				return fail(
					"bad_request",
					`the line is ${bytes} bytes, over this adapter's limit of ${limit}`,
				);
			}
			try {
				const seq = storage.transactionSync(() => {
					ensureTable();
					const rows = storage.sql
						.exec("SELECT COALESCE(MAX(seq), -1) AS last FROM lyra_entries")
						.toArray();
					const last = rows[0]?.["last"];
					const next = (typeof last === "number" ? last : -1) + 1;
					storage.sql.exec(
						"INSERT INTO lyra_entries (seq, line) VALUES (?, ?)",
						next,
						line,
					);
					return next;
				});
				return ok({ seq });
			} catch (error) {
				return fail("internal", `the record could not be saved: ${messageOf(error)}`);
			}
		},

		async read(): Promise<Result<string[]>> {
			try {
				ensureTable();
				const rows = storage.sql
					.exec("SELECT line FROM lyra_entries ORDER BY seq ASC")
					.toArray();
				const lines: string[] = [];
				for (const row of rows) {
					const line = row["line"];
					if (typeof line !== "string") {
						return fail("internal", "a saved line is not text");
					}
					lines.push(line);
				}
				return ok(lines);
			} catch (error) {
				return fail("internal", `the record could not be read: ${messageOf(error)}`);
			}
		},
	};
	return slot;
}

function messageOf(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, 200);
}
