import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";

import { loadRecord } from "../../record/load.js";
import type { StorageSlot } from "../../core/slots.js";
import { storageContract } from "../../testing/storage.contract.testing.js";
import { durableObjectStorage, type DurableObjectSqlStorage } from "./storage.js";

/**
 * The Cloudflare rows in `docs/adapters.md`: the shared storage contract (STO01 to
 * STO04) and CFL01 to CFL06.
 *
 * A Durable Object's storage belongs to the object, so every adapter call is made
 * inside it with `runInDurableObject`; that is also what makes the test faithful,
 * since the SQL runs in the object's own isolate over its own SQLite.
 */

type Stub = ReturnType<typeof sessionStub>;

function sessionStub() {
	const id = env.FIXTURE_SESSION.newUniqueId();
	return env.FIXTURE_SESSION.get(id);
}

/** One adapter call, run inside the object that owns the storage. */
function inside<T>(
	stub: Stub,
	callback: (storage: DurableObjectSqlStorage) => Promise<T> | T,
): Promise<T> {
	return runInDurableObject(stub, async (_instance, state) => callback(state.storage));
}

/** A StorageSlot over a fresh object's storage, so each contract case starts from zero. */
function storageIn(stub: Stub, maxEntryBytes?: number): StorageSlot {
	const options = maxEntryBytes === undefined ? {} : { maxEntryBytes };
	const slot: StorageSlot = {
		...(maxEntryBytes === undefined ? {} : { maxEntryBytes }),
		append: (line) =>
			inside(stub, (storage) => durableObjectStorage(storage, options).append(line)),
		read: () => inside(stub, (storage) => durableObjectStorage(storage, options).read()),
	};
	return slot;
}

storageContract({
	name: "cloudflare",
	create: (options) => storageIn(sessionStub(), options.maxLineBytes),
});

test("CFL01 a full 1 MiB entry saves and reads back byte for byte", async () => {
	const stub = sessionStub();
	const storage = storageIn(stub);
	const line = "a".repeat(1_048_576);

	const saved = await storage.append(line);
	expect(saved).toEqual({ ok: true, value: { seq: 0 } });

	const read = await storage.read();
	expect(read.ok).toBe(true);
	if (!read.ok) {
		return;
	}
	expect(read.value).toHaveLength(1);
	expect(read.value[0]).toBe(line);
	expect(new TextEncoder().encode(read.value[0]).length).toBe(1_048_576);
});

test("CFL02 the adapter's own limit is a ceiling: at it saves, one byte over is refused", async () => {
	const stub = sessionStub();
	const storage = storageIn(stub, 64);
	const atLimit = "z".repeat(64);
	const over = "y".repeat(65);

	expect(await storage.append(atLimit)).toEqual({ ok: true, value: { seq: 0 } });
	const refused = await storage.append(over);
	expect(refused.ok).toBe(false);
	if (!refused.ok) {
		expect(refused.error.code).toBe("bad_request");
		expect(refused.error.message).toContain("over this adapter's limit");
	}
	// Nothing was stored for the refusal, and the over-long text is not in the message.
	expect(await storage.read()).toEqual({ ok: true, value: [atLimit] });
	if (!refused.ok) {
		expect(refused.error.message).not.toContain("yyyy");
	}
});

test("CFL03 a storage that fails comes back as an error result, not a throw", async () => {
	const broken: DurableObjectSqlStorage = {
		sql: {
			exec() {
				throw new Error("the disk is on fire");
			},
		},
		transactionSync<T>(callback: () => T): T {
			return callback();
		},
	};

	let storage: StorageSlot | undefined;
	expect(() => {
		storage = durableObjectStorage(broken);
	}).not.toThrow();
	if (storage === undefined) {
		return;
	}
	const appended = await storage.append("{}");
	expect(appended.ok).toBe(false);
	if (!appended.ok) {
		expect(appended.error.code).toBe("internal");
		expect(appended.error.message).toContain("could not be saved");
	}
	const read = await storage.read();
	expect(read.ok).toBe(false);
	if (!read.ok) {
		expect(read.error.code).toBe("internal");
	}
});

test("CFL04 appends issued together get distinct, increasing seq values", async () => {
	const stub = sessionStub();
	const collected = await inside(stub, async (storage) => {
		const adapter = durableObjectStorage(storage);
		return Promise.all([
			adapter.append('{"n":1}'),
			adapter.append('{"n":2}'),
			adapter.append('{"n":3}'),
		]);
	});
	const seqs = collected.map((result) => (result.ok ? result.value.seq : -1));
	expect(seqs).toEqual([0, 1, 2]);
	expect(await inside(stub, (storage) => durableObjectStorage(storage).read())).toEqual({
		ok: true,
		value: ['{"n":1}', '{"n":2}', '{"n":3}'],
	});
});

test("CFL05 what was written survives eviction", async () => {
	const stub = sessionStub();
	const storage = storageIn(stub);
	expect(await storage.append('{"n":1}')).toEqual({ ok: true, value: { seq: 0 } });

	await evictDurableObject(stub);

	const read = await storage.read();
	expect(read).toEqual({ ok: true, value: ['{"n":1}'] });
	// The next append continues the sequence rather than starting again.
	expect(await storage.append('{"n":2}')).toEqual({ ok: true, value: { seq: 1 } });
});

test("CFL06 a damaged row is read as it is and loads tolerantly", async () => {
	const stub = sessionStub();
	const damaged = '{"type":"a kind this build does not know"}';
	await inside(stub, async (storage) => {
		await durableObjectStorage(storage).read();
		storage.sql.exec("INSERT INTO lyra_entries (seq, line) VALUES (?, ?)", 0, damaged);
	});

	const read = await storageIn(stub).read();
	expect(read.ok).toBe(true);
	if (!read.ok) {
		return;
	}
	expect(read.value).toEqual([damaged]);

	// The record loader keeps an unknown kind and notes nothing fatal; it is the
	// core's own tolerance, reached through real storage.
	const loaded = loadRecord([
		JSON.stringify({ v: 1, run: "r", task: "t", startedAt: 1, host: "h", type: "header" }),
		damaged,
	]);
	expect(loaded.ok).toBe(true);
});
