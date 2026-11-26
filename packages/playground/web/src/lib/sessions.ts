/**
 * Conversations: the playground's own list, over its own routes (issue #60, slice 3).
 *
 * The protocol has no `list_sessions` and will not get one from this page: the index is
 * the playground's (decision 158). So this file talks to `/api/sessions` and
 * `/api/recipes`, and it keeps the one rule the protocol's client shares — a `403`
 * clears the token, because the person is holding a credential the deployment refused.
 *
 * `fetch` is passed in, so every case here is a test on Node: an unreadable list, a
 * refusal that is not a refusal, and a body that is not the shape it claims.
 */

import type { Fetcher, Refusal } from "./playground.js";

/** One conversation as the sidebar draws it. */
export interface Conversation {
	session: string;
	label: string;
	recipe: string;
	lastUsed: number;
}

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: Refusal };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refusalOf(value: unknown, status: number): Refusal {
	if (isRecord(value) && isRecord(value["error"])) {
		const code = value["error"]["code"];
		const message = value["error"]["message"];
		return {
			code: typeof code === "string" ? code : "internal",
			message: typeof message === "string" ? message : `the server answered ${status}`,
			status,
		};
	}
	return { code: "internal", message: `the server answered ${status}`, status };
}

/**
 * One `/api/*` call, decoded by the caller.
 *
 * The response is read once, as JSON, because every route this page uses answers JSON
 * including its refusals. A body that will not parse is `internal` rather than a crash:
 * a deployment ahead of the page answers with something this one has not learned.
 */
async function call(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	path: string;
	method?: string;
	body?: unknown;
}): Promise<ApiResult<unknown>> {
	let response: Response;
	try {
		response = await options.fetcher(`${options.base}${options.path}`, {
			method: options.method ?? "GET",
			headers: {
				authorization: `Bearer ${options.token}`,
				...(options.body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
		});
	} catch (error) {
		return {
			ok: false,
			error: {
				code: "network_error",
				message: error instanceof Error ? error.message : "the request could not be sent",
				status: 0,
			},
		};
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		body = undefined;
	}
	if (!response.ok) {
		return { ok: false, error: refusalOf(body, response.status) };
	}
	return { ok: true, value: body };
}

/** The recipes the Worker offers, in its own order. */
export async function recipes(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
}): Promise<ApiResult<string[]>> {
	const answer = await call({ ...options, path: "/api/recipes" });
	if (!answer.ok) {
		return answer;
	}
	const list = isRecord(answer.value) ? answer.value["recipes"] : undefined;
	if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no recipe list", status: 200 },
		};
	}
	return { ok: true, value: list as string[] };
}

function conversationOf(value: unknown): Conversation | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const session = value["session"];
	const label = value["label"];
	const recipe = value["recipe"];
	const lastUsed = value["lastUsed"];
	if (
		typeof session !== "string" ||
		session === "" ||
		typeof label !== "string" ||
		typeof recipe !== "string" ||
		typeof lastUsed !== "number"
	) {
		return undefined;
	}
	return { session, label, recipe, lastUsed };
}

/** The sidebar's list. An entry the page cannot draw is dropped, not rendered broken. */
export async function listConversations(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
}): Promise<ApiResult<Conversation[]>> {
	const answer = await call({ ...options, path: "/api/sessions" });
	if (!answer.ok) {
		return answer;
	}
	const list = isRecord(answer.value) ? answer.value["sessions"] : undefined;
	if (!Array.isArray(list)) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no session list", status: 200 },
		};
	}
	const conversations: Conversation[] = [];
	for (const entry of list) {
		const conversation = conversationOf(entry);
		if (conversation !== undefined) {
			conversations.push(conversation);
		}
	}
	return { ok: true, value: conversations };
}

/** Ask the Worker to mint a conversation, and hand back the id it will be started on. */
export async function createConversation(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	recipe: string;
	label: string;
}): Promise<ApiResult<string>> {
	const answer = await call({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: "/api/sessions",
		method: "POST",
		body: { recipe: options.recipe, label: options.label.trim() },
	});
	if (!answer.ok) {
		return answer;
	}
	const session = isRecord(answer.value) ? answer.value["session"] : undefined;
	if (typeof session !== "string" || session === "") {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no session", status: 201 },
		};
	}
	return { ok: true, value: session };
}

/** Say a conversation was used, so it moves to the top of the sidebar. */
export async function touchConversation(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	session: string;
}): Promise<ApiResult<Conversation>> {
	const answer = await call({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: `/api/sessions/${encodeURIComponent(options.session)}`,
		method: "PUT",
		body: {},
	});
	if (!answer.ok) {
		return answer;
	}
	const conversation = conversationOf(answer.value);
	if (conversation === undefined) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer named no conversation", status: 200 },
		};
	}
	return { ok: true, value: conversation };
}

/** Which conversation the URL names, if any. */
export function sessionFromSearch(search: string): string | undefined {
	const value = new URLSearchParams(search).get("session");
	const trimmed = value?.trim() ?? "";
	return trimmed === "" ? undefined : trimmed;
}

/**
 * The URL a selection is kept in: the session id in the query, every other parameter
 * untouched.
 *
 * A query rather than a path segment because the app is a static single-page shell: a
 * path like `/c/<id>` matches no route SvelteKit has, so the fallback would render the
 * error page before the page could read it, while `?session=` is read by the route that
 * already exists (decision 159).
 */
export function withSession(path: string, search: string, session: string | undefined): string {
	const params = new URLSearchParams(search);
	if (session === undefined) {
		params.delete("session");
	} else {
		params.set("session", session);
	}
	const query = params.toString();
	return query === "" ? path : `${path}?${query}`;
}

/** What the deployment says about today's spend (issue #60, slice 7). */
export interface CapState {
	day: string;
	usd: number;
	unpriced: boolean;
	/** The cap in dollars, or `null` when the deployment set none. */
	cap: number | null;
}

/** The day's spend and the cap it is measured against. */
export async function readCap(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
}): Promise<ApiResult<CapState>> {
	const answer = await call({ ...options, path: "/api/cap" });
	if (!answer.ok) {
		return answer;
	}
	if (!isRecord(answer.value)) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no spend", status: 200 },
		};
	}
	const { day, usd, unpriced, cap } = answer.value;
	if (
		typeof day !== "string" ||
		typeof usd !== "number" ||
		typeof unpriced !== "boolean" ||
		(cap !== null && typeof cap !== "number")
	) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no spend", status: 200 },
		};
	}
	return { ok: true, value: { day, usd, unpriced, cap } };
}

/**
 * Tell the deployment what a run cost, or that it did not say.
 *
 * A run's `run_end` is where the cost is known, and the page is the client that sees it.
 * That makes the cap a spend guardrail behind the token rather than an authorization
 * boundary — the decision says so — and an unpriced reply is reported as itself so the day
 * can stop taking work rather than quietly undercount.
 */
export async function reportSpend(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	amount?: number;
	unpriced?: boolean;
}): Promise<ApiResult<CapState>> {
	const answer = await call({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: "/api/spend",
		method: "POST",
		body: options.unpriced === true ? { unpriced: true } : { amount: options.amount ?? 0 },
	});
	if (!answer.ok) {
		return answer;
	}
	const value = answer.value;
	if (
		!isRecord(value) ||
		typeof value["day"] !== "string" ||
		typeof value["usd"] !== "number" ||
		typeof value["unpriced"] !== "boolean"
	) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no spend", status: 200 },
		};
	}
	return {
		ok: true,
		value: {
			day: value["day"],
			usd: value["usd"],
			unpriced: value["unpriced"],
			cap: typeof value["cap"] === "number" ? value["cap"] : null,
		},
	};
}
