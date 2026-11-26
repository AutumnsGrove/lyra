/**
 * The per-tenant index of conversations (issue #60, slice 3).
 *
 * The sidebar needs a list of conversations, and Lyra's protocol answers
 * `list_sessions` with `unsupported` on purpose: an index across sessions is a design
 * of its own, not a thing one session can answer (decision 158). So the playground owns
 * one.
 *
 * It is a Durable Object named for the tenant, holding one entry per conversation: the
 * session id, the label the page drew, **the recipe the conversation runs**, and when it
 * was last used. The recipe is here rather than in the session because a conversation
 * keeps the recipe it was started with (decision 91): a person picks one at "new
 * conversation", and the sidebar can say which one it was without opening the session.
 *
 * Storage is the object's key-value surface rather than SQL because the index only ever
 * reads or writes a whole entry by key, and a handful of entries is all a rig holds. The
 * `SessionIndex` class takes the storage it is given, so a test drives a `Map` and an
 * eviction is a second instance over the same one.
 */

/** What the sidebar draws, and nothing more. */
export interface IndexEntry {
	/** The session id a `start` names, which is the Durable Object's own id as a string. */
	session: string;
	/** The page's own words for the conversation, trimmed and cut to the cap. */
	label: string;
	/** The recipe this conversation was started with, and keeps. */
	recipe: string;
	/** Milliseconds since the epoch, from the caller's clock. */
	lastUsed: number;
}

/**
 * The slice of Durable Object storage this object uses, narrowed to what a test can fake.
 *
 * `list` returns a `Map` because that is what the platform's own storage does, and a
 * rewrite to `Record` here would be a second thing to keep in step with it.
 */
export interface IndexStorage {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
	list(options?: { prefix?: string }): Promise<Map<string, unknown>>;
}

export interface IndexState {
	readonly storage: IndexStorage;
}

/** Every entry's key, so a list is a prefix read and a stray key is not an entry. */
export const ENTRY_PREFIX = "session:";

/** The label is a sidebar line: long enough to say what it is, short enough not to wrap. */
export const MAX_LABEL_CHARS = 80;

/** A rig's index, newest hundred: enough to prove a sidebar, little enough to list fast. */
export const MAX_ENTRIES = 100;

interface Outcome {
	status: number;
	value: unknown;
}

function refusal(status: number, code: string, message: string): Outcome {
	return { status, value: { error: { code, message } } };
}

function answered(value: unknown): Outcome {
	return { status: 200, value };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An entry as it was stored, or nothing when what was stored is not one. */
function entryOf(value: unknown): IndexEntry | undefined {
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
		recipe === "" ||
		typeof lastUsed !== "number" ||
		!Number.isFinite(lastUsed)
	) {
		return undefined;
	}
	return { session, label, recipe, lastUsed };
}

/** A requested label, trimmed and cut: a label that is not a string is a bad request. */
function labelOf(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	return value.trim().slice(0, MAX_LABEL_CHARS);
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

export class SessionIndex {
	constructor(private readonly ctx: IndexState) {}

	/** The routes the Worker drives: `/list`, `/create`, `/touch`, all JSON. */
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const route = url.pathname;
		if (request.method === "GET" && route === "/list") {
			return this.#respond(answered({ sessions: await this.list() }));
		}
		if (request.method === "POST" && (route === "/create" || route === "/touch")) {
			return this.#respond(await this.#write(route, await readJson(request)));
		}
		return this.#respond(refusal(404, "not_found", `the index has nothing at ${route}`));
	}

	async list(): Promise<IndexEntry[]> {
		const stored = await this.ctx.storage.list({ prefix: ENTRY_PREFIX });
		const entries: IndexEntry[] = [];
		stored.forEach((value) => {
			const entry = entryOf(value);
			if (entry !== undefined) {
				entries.push(entry);
			}
		});
		// Newest first, and the id breaks a tie so two conversations saved in the same
		// millisecond keep a stable order rather than swapping on every read.
		entries.sort(
			(left, right) =>
				right.lastUsed - left.lastUsed || (left.session < right.session ? -1 : 1),
		);
		return entries.slice(0, MAX_ENTRIES);
	}

	async create(entry: IndexEntry): Promise<IndexEntry> {
		const stored: IndexEntry = {
			session: entry.session,
			label: entry.label.slice(0, MAX_LABEL_CHARS),
			recipe: entry.recipe,
			lastUsed: entry.lastUsed,
		};
		await this.ctx.storage.put(`${ENTRY_PREFIX}${stored.session}`, stored);
		return stored;
	}

	async touch(input: {
		session: string;
		lastUsed: number;
		label?: string;
	}): Promise<IndexEntry | undefined> {
		const key = `${ENTRY_PREFIX}${input.session}`;
		const existing = entryOf(await this.ctx.storage.get(key));
		if (existing === undefined) {
			return undefined;
		}
		const next: IndexEntry = {
			...existing,
			lastUsed: input.lastUsed,
			...(input.label === undefined ? {} : { label: input.label }),
		};
		await this.ctx.storage.put(key, next);
		return next;
	}

	async #write(route: string, body: unknown): Promise<Outcome> {
		if (!isRecord(body)) {
			return refusal(400, "bad_request", "an index write holds one object of JSON");
		}
		const session = textOf(body["session"]);
		if (session === undefined) {
			return refusal(400, "bad_request", "a conversation needs a session id");
		}
		const lastUsed = body["lastUsed"];
		if (typeof lastUsed !== "number" || !Number.isFinite(lastUsed)) {
			return refusal(400, "bad_request", "a conversation needs the time it was used");
		}

		if (route === "/touch") {
			const label = body["label"] === undefined ? undefined : labelOf(body["label"]);
			if (body["label"] !== undefined && label === undefined) {
				return refusal(400, "bad_request", "a label is text");
			}
			const touched = await this.touch({
				session,
				lastUsed,
				...(label === undefined ? {} : { label }),
			});
			return touched === undefined
				? refusal(404, "not_found", "there is no such conversation")
				: answered(touched);
		}

		const recipe = textOf(body["recipe"]);
		if (recipe === undefined) {
			return refusal(400, "bad_request", "a conversation needs the recipe it runs");
		}
		const label = labelOf(body["label"]);
		if (label === undefined || label === "") {
			return refusal(400, "bad_request", "a conversation needs a label to draw");
		}
		return answered(await this.create({ session, label, recipe, lastUsed }));
	}

	#respond(outcome: Outcome): Response {
		return new Response(JSON.stringify(outcome.value), {
			status: outcome.status,
			headers: { "content-type": "application/json" },
		});
	}
}

/** The body as JSON, or nothing: the object never trusts what a stub was given. */
async function readJson(request: Request): Promise<unknown> {
	try {
		return JSON.parse(await request.text());
	} catch {
		return undefined;
	}
}
