/**
 * A tenant's spend for one UTC day (issue #60, slice 7).
 *
 * The playground has a hard cap per tenant per day, and the cap has to be checked before a
 * run starts rather than after it spends. The count lives in this object, named for the
 * tenant, because it outlives any one session and any one view of the page.
 *
 * Two things make it honest rather than approximate. **The day is part of every read and
 * write**, so a write for a new day resets the count instead of adding to yesterday's, and
 * a read for a day that has passed says zero rather than showing a stale number. And **a
 * day can be marked unpriced**: a reply that reported no cost means the total can no longer
 * be trusted, and a hard cap that silently undercounted would be worse than no cap at all.
 * Once a day is unpriced it stays unpriced until the next one, whatever else is spent.
 */

/** What a day holds: the money it has spent, and whether every reply priced itself. */
export interface BudgetState {
	/** The UTC day, as `YYYY-MM-DD`. */
	day: string;
	usd: number;
	unpriced: boolean;
}

/** The slice of Durable Object storage this object uses, narrowed so a test can fake it. */
export interface BudgetStorage {
	get(key: string): Promise<unknown>;
	put(key: string, value: unknown): Promise<void>;
}

export interface BudgetStateSlot {
	readonly storage: BudgetStorage;
}

/** One tenant holds one day at a time, so one key is the whole store. */
const KEY = "day";

/** A day is `YYYY-MM-DD` and nothing else: a timestamp here would make "today" ambiguous. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

interface Action {
	status: number;
	value: unknown;
}

function answered(value: unknown): Action {
	return { status: 200, value };
}

function refused(message: string): Action {
	return { status: 400, value: { error: { code: "bad_request", message } } };
}

function roundUsd(amount: number): number {
	return Math.round(amount * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function dayOf(value: unknown): string | undefined {
	return typeof value === "string" && DAY.test(value) ? value : undefined;
}

function amountOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A stored day, or an empty one when nothing valid is stored. */
function stateOf(value: unknown): BudgetState | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	const day = dayOf(value["day"]);
	const usd = amountOf(value["usd"]);
	const unpriced = value["unpriced"] === true;
	if (day === undefined || usd === undefined) {
		return undefined;
	}
	return { day, usd, unpriced };
}

export class Budget {
	constructor(private readonly ctx: BudgetStateSlot) {}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/status") {
			const day = dayOf(url.searchParams.get("day"));
			if (day === undefined) {
				return this.#respond(refused("the status needs a UTC day as YYYY-MM-DD"));
			}
			return this.#respond(answered(await this.#for(day)));
		}
		if (
			request.method === "POST" &&
			(url.pathname === "/spend" || url.pathname === "/unpriced")
		) {
			const body = await readJson(request);
			return this.#respond(await this.#write(url.pathname, body));
		}
		return this.#respond({
			status: 404,
			value: {
				error: { code: "not_found", message: `the budget has nothing at ${url.pathname}` },
			},
		});
	}

	/** The day as this object counts it, or an empty day when the stored one is another. */
	async state(day: string): Promise<BudgetState> {
		return this.#for(day);
	}

	async #for(day: string): Promise<BudgetState> {
		const stored = stateOf(await this.ctx.storage.get(KEY));
		return stored !== undefined && stored.day === day
			? stored
			: { day, usd: 0, unpriced: false };
	}

	async #write(path: string, body: unknown): Promise<Action> {
		if (!isRecord(body)) {
			return refused("a budget write holds one object of JSON");
		}
		const day = dayOf(body["day"]);
		if (day === undefined) {
			return refused("a budget write needs a UTC day as YYYY-MM-DD");
		}
		const current = await this.#for(day);

		if (path === "/unpriced") {
			const next: BudgetState = { ...current, unpriced: true };
			await this.ctx.storage.put(KEY, next);
			return answered(next);
		}

		const amount = amountOf(body["amount"]);
		if (amount === undefined) {
			return refused("a spend is a number of dollars, zero or more");
		}
		// Money is rounded to a millionth of a dollar as it is added: model costs are
		// fractions of a cent, and a float sum of them drifts into numbers no cap should
		// compare (`0.2 + 0.1` is not `0.3`). A micro-dollar is the rig's smallest unit.
		const next: BudgetState = { ...current, usd: roundUsd(current.usd + amount) };
		await this.ctx.storage.put(KEY, next);
		return answered(next);
	}

	#respond(action: Action): Response {
		return new Response(JSON.stringify(action.value), {
			status: action.status,
			headers: { "content-type": "application/json" },
		});
	}
}

async function readJson(request: Request): Promise<unknown> {
	try {
		return JSON.parse(await request.text());
	} catch {
		return undefined;
	}
}
