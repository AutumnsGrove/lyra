import { expect, test } from "vitest";

import type { Fetcher } from "./playground.js";
import {
	createConversation,
	listConversations,
	readCap,
	recipes,
	reportSpend,
	sessionFromSearch,
	touchConversation,
	withSession,
} from "./sessions.js";

/**
 * The rows are in `docs/playground.md`: PGS17 to PGS21, as far as the page's client
 * logic is concerned. The component tests prove the wiring; these prove the decoding,
 * which is where an unreadable answer would otherwise become a blank sidebar.
 */

/** One answer, and the request that asked for it. */
function answering(response: () => Response): { fetcher: Fetcher; calls: RequestInit[] } {
	const calls: RequestInit[] = [];
	const fetcher: Fetcher = async (_url, init) => {
		calls.push(init ?? {});
		return response();
	};
	return { fetcher, calls };
}

function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

test("PGS17 the recipe list is the Worker's, and a refusal keeps its status", async () => {
	const offered = answering(() => json({ recipes: ["shell", "tool-table"] }));
	const result = await recipes({
		base: "",
		token: "t",
		fetcher: offered.fetcher,
	});
	expect(result).toEqual({ ok: true, value: ["shell", "tool-table"] });
	expect(offered.calls[0]?.headers).toMatchObject({ authorization: "Bearer t" });

	const refused = answering(() =>
		json({ error: { code: "permission_denied", message: "nope" } }, 403),
	);
	const denied = await recipes({ base: "", token: "t", fetcher: refused.fetcher });
	expect(denied).toEqual({
		ok: false,
		error: { code: "permission_denied", message: "nope", status: 403 },
	});

	// A list that is not a list of names is not a recipe picker.
	const nonsense = answering(() => json({ recipes: [1, 2] }));
	expect(await recipes({ base: "", token: "t", fetcher: nonsense.fetcher })).toMatchObject({
		ok: false,
		error: { code: "internal" },
	});
});

test("PGS17 a new conversation is created with its recipe and label, and hands back its id", async () => {
	const created = answering(() => json({ session: "s_1" }, 201));
	const result = await createConversation({
		base: "",
		token: "t",
		fetcher: created.fetcher,
		recipe: "tool-table",
		label: "  what time is it?  ",
	});

	expect(result).toEqual({ ok: true, value: "s_1" });
	expect(created.calls[0]).toMatchObject({
		method: "POST",
		headers: { authorization: "Bearer t", "content-type": "application/json" },
	});
	expect(JSON.parse(String(created.calls[0]?.body))).toEqual({
		recipe: "tool-table",
		label: "what time is it?",
	});
});

test("PGS18 the sidebar's list keeps only what it can draw", async () => {
	const listed = answering(() =>
		json({
			sessions: [
				{ session: "a", label: "one", recipe: "shell", lastUsed: 2 },
				{ session: "b", recipe: "shell", lastUsed: 1 },
				{ label: "no id", recipe: "shell", lastUsed: 3 },
				"nonsense",
			],
		}),
	);
	const result = await listConversations({ base: "", token: "t", fetcher: listed.fetcher });
	expect(result).toEqual({
		ok: true,
		value: [{ session: "a", label: "one", recipe: "shell", lastUsed: 2 }],
	});

	// An answer that is not a list at all is a message rather than a crash: the page is
	// talking to a deployment that may be a version ahead of it.
	const wrong = answering(() => json({ sessions: "none" }));
	expect(await listConversations({ base: "", token: "t", fetcher: wrong.fetcher })).toMatchObject(
		{ ok: false, error: { code: "internal" } },
	);
});

test("PGS19 a conversation is touched without carrying a label it did not change", async () => {
	const touched = answering(() =>
		json({ session: "a", label: "one", recipe: "shell", lastUsed: 9 }),
	);
	const result = await touchConversation({
		base: "",
		token: "t",
		fetcher: touched.fetcher,
		session: "a",
	});
	expect(result).toMatchObject({ ok: true, value: { session: "a", lastUsed: 9 } });
	expect(touched.calls[0]?.method).toBe("PUT");
	expect(JSON.parse(String(touched.calls[0]?.body))).toEqual({});
});

test("PGS20 the session id travels in the query, and nothing else is read from it", () => {
	expect(sessionFromSearch("?session=s_1")).toBe("s_1");
	expect(sessionFromSearch("?other=1&session=s_1")).toBe("s_1");
	expect(sessionFromSearch("")).toBeUndefined();
	expect(sessionFromSearch("?session=")).toBeUndefined();
	expect(sessionFromSearch("?session=%20")).toBeUndefined();
	// `withSession` is the other half: a selection replaces the id and keeps the path, so a
	// deep link is the same URL a reload lands on.
	expect(withSession("/", "?x=1", "s_1")).toBe("/?x=1&session=s_1");
	expect(withSession("/", "?session=old", "new")).toBe("/?session=new");
	expect(withSession("/", "?session=old", undefined)).toBe("/");
});

test("PGS40 the cap is read, and spend is reported as money or as unpriced", async () => {
	const asked: { path: string; body?: unknown }[] = [];
	const fetcher: Fetcher = async (url, init) => {
		const path = new URL(String(url), "http://localhost").pathname;
		asked.push({
			path,
			...(typeof init?.body === "string" ? { body: JSON.parse(init.body) } : {}),
		});
		if (path === "/api/cap") {
			return json({ day: "2026-11-26", usd: 0.25, unpriced: false, cap: 1 });
		}
		return json({ day: "2026-11-26", usd: 0.3, unpriced: true });
	};

	const cap = await readCap({ base: "", token: "t", fetcher });
	expect(cap).toEqual({
		ok: true,
		value: { day: "2026-11-26", usd: 0.25, unpriced: false, cap: 1 },
	});

	// A cap the deployment did not set is `null`, not zero: zero would read as "nothing
	// may run", which is a different statement.
	const uncapped = await readCap({
		base: "",
		token: "t",
		fetcher: async () => json({ day: "2026-11-26", usd: 0, unpriced: false, cap: null }),
	});
	expect(uncapped).toMatchObject({ ok: true, value: { cap: null } });

	await reportSpend({ base: "", token: "t", fetcher, amount: 0.05 });
	await reportSpend({ base: "", token: "t", fetcher, unpriced: true });
	expect(asked).toEqual([
		{ path: "/api/cap" },
		{ path: "/api/spend", body: { amount: 0.05 } },
		{ path: "/api/spend", body: { unpriced: true } },
	]);

	const broken = await readCap({
		base: "",
		token: "t",
		fetcher: async () => json({ usd: "a lot" }),
	});
	expect(broken).toMatchObject({ ok: false, error: { code: "internal" } });
});
