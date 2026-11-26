import { expect, test } from "vitest";

import { memoryIndex } from "./index-do.testing.js";
import { ENTRY_PREFIX, MAX_ENTRIES, MAX_LABEL_CHARS, SessionIndex } from "./index-do.js";

/**
 * The rows are in `docs/playground.md`: PGS11 to PGS14.
 *
 * The subject is the object's own storage, driven the way the Worker drives it. The
 * fake is a `Map` rather than Durable Object SQLite because the index only ever reads
 * and writes whole entries by key, and the question these tests ask is what the object
 * promises, not how the platform keeps it.
 */

function request(path: string, body?: unknown, method = "POST"): Request {
	return new Request(`https://index.test${path}`, {
		method: body === undefined ? method : "POST",
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	});
}

async function body(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

test("PGS11 a conversation is written under the tenant's own index and read back", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });

	const created = await index.fetch(
		request("/create", {
			session: "abc",
			label: "  What time is it?  ",
			recipe: "tool-table",
			lastUsed: 1_000,
		}),
	);
	expect(created.status).toBe(200);
	expect(await body(created)).toEqual({
		session: "abc",
		label: "What time is it?",
		recipe: "tool-table",
		lastUsed: 1_000,
	});

	const listed = await index.fetch(request("/list", undefined, "GET"));
	expect(await body(listed)).toEqual({
		sessions: [
			{ session: "abc", label: "What time is it?", recipe: "tool-table", lastUsed: 1_000 },
		],
	});
});

test("PGS11 the index refuses an entry it could not draw, and writes nothing", async () => {
	const { storage, map } = memoryIndex();
	const index = new SessionIndex({ storage });

	const cases: { body: unknown; why: string }[] = [
		{ body: { label: "x", recipe: "shell", lastUsed: 1 }, why: "no session" },
		{ body: { session: "a", label: "x", lastUsed: 1 }, why: "no recipe" },
		{ body: { session: "a", recipe: "shell", lastUsed: 1 }, why: "no label" },
		{ body: { session: "a", label: "   ", recipe: "shell", lastUsed: 1 }, why: "blank label" },
		{
			body: { session: "a", label: "x", recipe: "shell", lastUsed: Number.NaN },
			why: "no time",
		},
		{ body: { session: 3, label: "x", recipe: "shell", lastUsed: 1 }, why: "wrong types" },
		{ body: [], why: "not an object" },
	];

	for (const { body: entry, why } of cases) {
		const response = await index.fetch(request("/create", entry));
		expect(response.status, why).toBe(400);
		const refused = await body(response);
		expect((refused["error"] as { code?: string }).code, why).toBe("bad_request");
	}
	expect(map.size).toBe(0);
});

test("PGS11 a body that is not JSON is refused rather than thrown", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });

	const response = await index.fetch(
		new Request("https://index.test/create", { method: "POST", body: "{not json" }),
	);
	expect(response.status).toBe(400);
	expect((await body(response))["error"]).toMatchObject({ code: "bad_request" });
});

test("PGS12 the list is newest first, and a label is cut rather than refused", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });

	await index.fetch(
		request("/create", { session: "old", label: "old", recipe: "shell", lastUsed: 1 }),
	);
	await index.fetch(
		request("/create", { session: "new", label: "new", recipe: "shell", lastUsed: 3 }),
	);
	await index.fetch(
		request("/create", { session: "mid", label: "mid", recipe: "shell", lastUsed: 2 }),
	);
	const long = "x".repeat(MAX_LABEL_CHARS + 40);
	const cut = await index.fetch(
		request("/create", { session: "long", label: long, recipe: "shell", lastUsed: 0 }),
	);
	expect((await body(cut))["label"]).toBe("x".repeat(MAX_LABEL_CHARS));

	const listed = await index.fetch(request("/list", undefined, "GET"));
	const sessions = (await body(listed))["sessions"] as { session: string }[];
	expect(sessions.map((entry) => entry.session)).toEqual(["new", "mid", "old", "long"]);
});

test("PGS12 a conversation created under one key does not appear under another", async () => {
	// The key is the whole conversation: a value stored under a name that is not an entry
	// is not listed, which is what keeps a stray key from drawing a broken sidebar row.
	const { storage, map } = memoryIndex();
	const index = new SessionIndex({ storage });

	await index.fetch(
		request("/create", { session: "abc", label: "x", recipe: "shell", lastUsed: 1 }),
	);
	map.set("elsewhere", { session: "zzz" });
	map.set(`${ENTRY_PREFIX}broken`, { session: "zzz" });

	const listed = await index.fetch(request("/list", undefined, "GET"));
	const sessions = (await body(listed))["sessions"] as { session: string }[];
	expect(sessions.map((entry) => entry.session)).toEqual(["abc"]);
});

test("PGS12 the list stops at the cap, newest kept", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });

	for (let count = 0; count < MAX_ENTRIES + 5; count += 1) {
		await index.fetch(
			request("/create", {
				session: `s${count}`,
				label: `s${count}`,
				recipe: "shell",
				lastUsed: count,
			}),
		);
	}

	const listed = await index.fetch(request("/list", undefined, "GET"));
	const sessions = (await body(listed))["sessions"] as { session: string }[];
	expect(sessions).toHaveLength(MAX_ENTRIES);
	expect(sessions[0]?.session).toBe(`s${MAX_ENTRIES + 4}`);
});

test("PGS13 using a conversation moves it up, and relabels only when told to", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });

	await index.fetch(
		request("/create", { session: "a", label: "one", recipe: "shell", lastUsed: 1 }),
	);
	await index.fetch(
		request("/create", { session: "b", label: "two", recipe: "shell", lastUsed: 2 }),
	);

	const touched = await index.fetch(request("/touch", { session: "a", lastUsed: 5 }));
	expect(touched.status).toBe(200);
	expect(await body(touched)).toMatchObject({ session: "a", label: "one", lastUsed: 5 });

	const relabelled = await index.fetch(
		request("/touch", { session: "a", lastUsed: 6, label: "renamed" }),
	);
	expect(await body(relabelled)).toMatchObject({ label: "renamed", lastUsed: 6 });

	const listed = await index.fetch(request("/list", undefined, "GET"));
	const sessions = (await body(listed))["sessions"] as { session: string }[];
	expect(sessions.map((entry) => entry.session)).toEqual(["a", "b"]);
});

test("PGS13 a touch names a conversation that exists, and creates nothing when it does not", async () => {
	const { storage, map } = memoryIndex();
	const index = new SessionIndex({ storage });

	const response = await index.fetch(request("/touch", { session: "nobody", lastUsed: 5 }));
	expect(response.status).toBe(404);
	expect((await body(response))["error"]).toMatchObject({ code: "not_found" });
	expect(map.size).toBe(0);

	// A block that says nothing falls through to the same refusal rather than a crash:
	// the route list is the object's own, and anything else is not found.
	const unknown = await index.fetch(request("/nothing", { session: "a", lastUsed: 5 }));
	expect(unknown.status).toBe(404);
});

test("PGS16 a rebuilt object lists what the one before it wrote", async () => {
	// An eviction is a new instance over the same storage, which is what the platform
	// promises; the index must hold nothing in a field that a rebuild loses.
	const { storage } = memoryIndex();
	const first = new SessionIndex({ storage });
	await first.fetch(
		request("/create", { session: "abc", label: "kept", recipe: "shell", lastUsed: 7 }),
	);

	const rebuilt = new SessionIndex({ storage });
	const listed = await rebuilt.fetch(request("/list", undefined, "GET"));
	expect(await body(listed)).toEqual({
		sessions: [{ session: "abc", label: "kept", recipe: "shell", lastUsed: 7 }],
	});
});

test("PGS13 a touch cannot blank the label the sidebar draws", async () => {
	const { storage } = memoryIndex();
	const index = new SessionIndex({ storage });
	await index.fetch(
		request("/create", { session: "a", label: "one", recipe: "shell", lastUsed: 1 }),
	);

	// A touch that carries a label means to change it, and a label that trims to nothing
	// would draw a blank row nobody could click on purpose. The create path already
	// refuses that, and a later route reaching the same field must refuse it too
	// (found in review).
	const blank = await index.fetch(request("/touch", { session: "a", lastUsed: 2, label: "   " }));
	expect(blank.status).toBe(400);
	expect((await body(blank))["error"]).toMatchObject({ code: "bad_request" });

	// The label the conversation had is still the one it has.
	const listed = await index.fetch(request("/list", undefined, "GET"));
	const sessions = (await body(listed))["sessions"] as { label: string; lastUsed: number }[];
	expect(sessions[0]).toMatchObject({ label: "one", lastUsed: 1 });
});
