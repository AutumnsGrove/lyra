/**
 * The playground's front door (issue #60, slices 1 and 3).
 *
 * One Worker serves three things: the page, from its static assets; `/v1/*`, which
 * `run_worker_first` in `wrangler.jsonc` sends here rather than to the assets layer; and
 * the playground's own `/api/*`, which is where a sidebar comes from. Everything
 * protocol-shaped is the Cloudflare adapter's `createSessionWorker`, so this file owns
 * no routing rules of its own beyond the one route Lyra does not speak.
 *
 * `/api/*` sits outside `/v1/*` on purpose: the conversation index is the playground's,
 * not Lyra's (decision 158), so a client of the protocol never learns it exists.
 */

import { createTokenDoor, statusForCode, systemClock, type ErrorCode } from "@autumnsgrove/lyra";
import {
	createSessionWorker,
	type DurableObjectNamespaceLike,
} from "@autumnsgrove/lyra/cloudflare";

import { capFrom, utcDay } from "./cap.js";
import { recipeCatalogue } from "./recipes/catalogue.js";
import { tokensFrom, type Env } from "./session.js";

export interface FrontDoor {
	/** The sessions, one object each. */
	namespace: DurableObjectNamespaceLike;
	/** The per-tenant conversation index (decision 158). */
	index: DurableObjectNamespaceLike;
	/** The per-tenant day's spend (decision 161). */
	budget: DurableObjectNamespaceLike;
	/** The day's cap in dollars, or `null` when the deployment set none. */
	cap: number | null;
	/** Tenant to token, from a secret binding. */
	tokens: Readonly<Record<string, string>>;
	/** The recipe names this Worker runs, in the picker's order. */
	recipes: readonly string[];
	/** The clock the index timestamps with, passed in so a test can pin it. */
	now: () => number;
}

/** An `/api/*` body is small: a label and a recipe name, never a conversation. */
const MAX_API_BODY_BYTES = 8 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One JSON answer, with the status that says whether it worked. */
function json(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A refusal the page reads the way it reads the protocol's: a code and a message. */
function refuse(code: ErrorCode, message: string): Response {
	return json({ error: { code, message } }, statusForCode(code));
}

/**
 * The body, read through the cap rather than after it, so an oversized request stops
 * being read instead of being read and then refused.
 *
 * The cap is bytes: a string's `length` is UTF-16 code units, so a body of three-byte
 * characters would pass a character count while carrying three times the bytes the
 * constant names (found in review).
 */
async function readCapped(request: Request): Promise<string | undefined> {
	const body = request.body;
	if (body === null) {
		return "";
	}
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			size += value.byteLength;
			if (size > MAX_API_BODY_BYTES) {
				// Past the cap: stop reading rather than buffer what nobody will parse.
				await reader.cancel().catch(() => undefined);
				return undefined;
			}
			chunks.push(value);
		}
	} catch {
		// A body that fails while it is read is a refusal, not an exception across the
		// route: a client that drops its connection must not become a 500.
		return undefined;
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let at = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, at);
		at += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/** The body as JSON, or nothing when it is too large, unreadable, or not an object. */
async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
	const text = await readCapped(request);
	if (text === undefined) {
		return undefined;
	}
	if (text.trim() === "") {
		// A touch carries nothing but its id, and that is a body of no fields rather than
		// a body the page failed to write.
		return {};
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The door as a function of its inputs, so a test can drive it with recording namespaces
 * and no bindings. The Worker's `fetch` is this, plus the environment.
 */
export function frontDoor(door: FrontDoor): (request: Request) => Promise<Response> {
	const open = createSessionWorker({ namespace: door.namespace, tokens: door.tokens });
	const tenantOf = createTokenDoor(door.tokens);

	return async (request) => {
		const url = new URL(request.url);
		if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
			return api(request, url, door, tenantOf);
		}
		return open(request);
	};
}

/**
 * The playground's own routes. They authenticate against the same token map the protocol
 * does, so a person who has opened the page has opened the sidebar with the same
 * credential, and a tenant is always the one its token resolved to rather than anything
 * the request said.
 */
async function api(
	request: Request,
	url: URL,
	door: FrontDoor,
	tenantOf: ReturnType<typeof createTokenDoor>,
): Promise<Response> {
	const tenant = await tenantOf(request);
	if (!tenant.ok) {
		return refuse(tenant.error.code as ErrorCode, tenant.error.message);
	}

	if (request.method === "GET" && url.pathname === "/api/recipes") {
		return json({ recipes: door.recipes });
	}

	if (url.pathname === "/api/cap" || url.pathname === "/api/spend") {
		const budget = door.budget.get(door.budget.idFromName(tenant.value));
		const day = utcDay(door.now());

		if (request.method === "GET" && url.pathname === "/api/cap") {
			const status = await budget.fetch(
				new Request(`https://budget.invalid/status?day=${encodeURIComponent(day)}`),
			);
			const state = (await status.json()) as Record<string, unknown>;
			return json({ ...state, cap: door.cap }, status.status);
		}

		if (request.method === "POST" && url.pathname === "/api/spend") {
			const body = await readJson(request);
			if (body === undefined) {
				return refuse("bad_request", "a spend holds one object of JSON");
			}
			const unpriced = body["unpriced"] === true;
			const amount = body["amount"];
			if (
				!unpriced &&
				(typeof amount !== "number" || !Number.isFinite(amount) || amount < 0)
			) {
				return refuse("bad_request", "a spend is a number of dollars, zero or more");
			}
			// The day is the Worker's, never the page's: a client that chose the day could
			// spread its spend across days it was never in.
			const spent = await budget.fetch(
				new Request(`https://budget.invalid/${unpriced ? "unpriced" : "spend"}`, {
					method: "POST",
					body: JSON.stringify(unpriced ? { day } : { day, amount }),
				}),
			);
			const state = (await spent.json()) as Record<string, unknown>;
			return json({ ...state, cap: door.cap }, spent.status);
		}

		return refuse("not_found", `there is nothing at ${url.pathname}`);
	}

	if (url.pathname !== "/api/sessions" && !url.pathname.startsWith("/api/sessions/")) {
		return refuse("not_found", `there is nothing at ${url.pathname}`);
	}

	// Named when a route actually needs it, so a request refused for its path or its
	// body never reaches the object at all: naming it is what a test counts as waking it.
	const index = () => door.index.get(door.index.idFromName(tenant.value));

	if (request.method === "GET" && url.pathname === "/api/sessions") {
		const listed = await index().fetch(new Request("https://index.invalid/list"));
		return json(await listed.json(), listed.status);
	}

	if (request.method === "POST" && url.pathname === "/api/sessions") {
		const body = await readJson(request);
		if (body === undefined) {
			return refuse("bad_request", "a new conversation holds one object of JSON");
		}
		const recipe = body["recipe"];
		if (typeof recipe !== "string" || recipe === "") {
			return refuse("bad_request", "a new conversation needs a recipe");
		}
		// Checked before the index is written, so a stale page cannot leave a conversation
		// in the sidebar that every later `start` would refuse.
		if (!door.recipes.includes(recipe)) {
			return refuse("not_found", `this Worker runs no recipe ${recipe}`);
		}
		const label = body["label"];
		if (typeof label !== "string" || label.trim() === "") {
			return refuse("bad_request", "a new conversation needs a label");
		}

		// The id comes from the sessions namespace, so the `start` the page sends next
		// lands on the object this entry names rather than on a second, empty one.
		const session = door.namespace.newUniqueId().toString();
		const created = await index().fetch(
			new Request("https://index.invalid/create", {
				method: "POST",
				body: JSON.stringify({ session, label, recipe, lastUsed: door.now() }),
			}),
		);
		if (!created.ok) {
			return json(await created.json(), created.status);
		}
		return json({ session }, 201);
	}

	if (request.method === "PUT" && url.pathname.startsWith("/api/sessions/")) {
		// A path is untrusted bytes: `%E0%A4%A` is not a UTF-8 escape, and decoding it
		// throws. A malformed id is a bad request, never a 500 (found in review).
		let session: string;
		try {
			session = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
		} catch {
			return refuse("bad_request", "a session id in the path is not a valid escape");
		}
		if (session === "") {
			return refuse("not_found", "there is no such conversation");
		}
		const body = await readJson(request);
		if (body === undefined) {
			return refuse("bad_request", "a touch holds one object of JSON, or none");
		}
		const label = body["label"];
		if (label !== undefined && typeof label !== "string") {
			return refuse("bad_request", "a label is text");
		}
		const touched = await index().fetch(
			new Request("https://index.invalid/touch", {
				method: "POST",
				body: JSON.stringify({
					session,
					lastUsed: door.now(),
					...(label === undefined ? {} : { label }),
				}),
			}),
		);
		return json(await touched.json(), touched.status);
	}

	return refuse("not_found", `there is nothing at ${url.pathname}`);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		// The runtime's own binding type is assignable to the three methods the adapter
		// names, so no cast is needed: the binding is narrowed by the type system rather
		// than by a promise in a comment (found in review on #81).
		const clock = systemClock();
		return frontDoor({
			namespace: env.SESSION,
			index: env.INDEX,
			budget: env.BUDGET,
			cap: capFrom(env),
			tokens: tokensFrom(env),
			recipes: [...recipeCatalogue(clock).keys()],
			now: () => clock.now(),
		})(request);
	},
} satisfies ExportedHandler<Env>;

export { Session } from "./session.js";
export { SessionIndex } from "./index-do.js";
export { Budget } from "./budget.js";
