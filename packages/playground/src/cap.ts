/**
 * The host's day cap (issue #60, slice 7; decision 161).
 *
 * The rule the plan asks for: a **new run** over the cap is refused, a run already going
 * finishes, and a reply that reported no cost marks the day unpriced. The refusal is the
 * host's, so it uses the `limit` code at 429 (decision 160) rather than a core limit, and
 * it happens **before** the command reaches the session — nothing is started, no record is
 * written, and no model is asked.
 *
 * The check is a function rather than a method so the policy can be driven without a
 * Durable Object: the budget is anything with a `fetch`, the day comes from the clock, and
 * the cap comes from a binding.
 */

/** The one thing this needs from the budget object. */
export interface BudgetLike {
	fetch(request: Request): Promise<Response>;
}

export interface CapEnv {
	/** The day's cap in dollars. Unset, blank or not money means no cap. */
	LYRA_PLAYGROUND_DAY_CAP_USD?: string | undefined;
}

/** The cap a deployment set, or nothing when it set none. */
export function capFrom(env: CapEnv): number | null {
	const raw = env.LYRA_PLAYGROUND_DAY_CAP_USD;
	if (typeof raw !== "string") {
		return null;
	}
	const value = Number(raw.trim());
	return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The UTC day a timestamp is in, as `YYYY-MM-DD`.
 *
 * UTC on purpose: a cap that rolled over at each person's local midnight would be a
 * different number for the same spend, and the plan says per UTC day.
 */
export function utcDay(now: number): string {
	return new Date(now).toISOString().slice(0, 10);
}

export interface Refusal {
	status: number;
	frame: {
		type: "response";
		id: string;
		command: string;
		ok: false;
		error: { code: "limit"; message: string };
	};
}

/** The refusal frame both doors send, built in one place so they cannot drift apart. */
function limitFrame(id: string, message: string): Refusal["frame"] {
	return {
		type: "response",
		id,
		command: "start",
		ok: false,
		error: { code: "limit", message },
	};
}

function unreadable(id: string): Refusal {
	return {
		status: 429,
		frame: limitFrame(id, "the day's spend could not be read, so no run was started"),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `start` a body holds, or nothing when it is not one. */
function startOf(body: unknown): { id: string; command: string } | undefined {
	if (!isRecord(body) || body["command"] !== "start") {
		return undefined;
	}
	const id = typeof body["id"] === "string" ? body["id"] : "";
	return { id, command: "start" };
}

/**
 * Why a command is refused, or nothing to send it on.
 *
 * Only a `start` is checked. A follow-up continues a run that was already allowed to spend,
 * and stopping a conversation mid-sentence for a cap it did not cross would be the cap
 * punishing the wrong thing.
 */
export async function refusalFor(options: {
	body: unknown;
	budget: BudgetLike;
	cap: number | null;
	day: string;
}): Promise<Refusal | undefined> {
	if (options.cap === null) {
		return undefined;
	}
	const start = startOf(options.body);
	if (start === undefined) {
		return undefined;
	}

	let response: Response;
	try {
		response = await options.budget.fetch(
			new Request(`https://budget.invalid/status?day=${encodeURIComponent(options.day)}`),
		);
	} catch {
		// A Durable Object that throws is the same answer as one that refuses: the spend
		// cannot be read, so nothing is started (found in review on #99).
		response = new Response(null, { status: 500 });
	}
	if (!response.ok) {
		// A budget that cannot be read is not a reason to spend: the refusal names the
		// budget rather than the cap, so the message is true about what failed.
		return {
			status: 429,
			frame: {
				type: "response",
				id: start.id,
				command: start.command,
				ok: false,
				error: {
					code: "limit",
					message: "the day's spend could not be read, so no run was started",
				},
			},
		};
	}
	const state: unknown = await response.json().catch(() => undefined);
	const usd = isRecord(state) && typeof state["usd"] === "number" ? state["usd"] : undefined;
	const unpriced = isRecord(state) && state["unpriced"] === true;
	if (usd === undefined) {
		return {
			status: 429,
			frame: {
				type: "response",
				id: start.id,
				command: start.command,
				ok: false,
				error: {
					code: "limit",
					message: "the day's spend could not be read, so no run was started",
				},
			},
		};
	}

	if (unpriced) {
		return {
			status: 429,
			frame: limitFrame(
				start.id,
				"a reply today reported no cost, so the day is unpriced and no new run starts until it rolls over in UTC",
			),
		};
	}
	if (usd >= options.cap) {
		return {
			status: 429,
			frame: limitFrame(
				start.id,
				`the playground has spent $${usd.toFixed(4)} of its $${options.cap.toFixed(2)} for today (UTC), so no new run starts until tomorrow`,
			),
		};
	}
	return undefined;
}

/**
 * The cap refusal for a frame that arrived on a socket, as the frame to send back.
 *
 * A `start` over an upgraded socket would otherwise skip the check entirely: the HTTP door
 * sees `fetch`, and a socket command goes straight to `webSocketMessage`. The reply is the
 * same `response` frame a socket already reads, and the socket stays open, so a person can
 * still answer the card they were on (found in review on #99).
 */
export async function socketRefusal(options: {
	message: string | ArrayBuffer;
	budget: BudgetLike;
	cap: number | null;
	day: string;
}): Promise<string | undefined> {
	if (typeof options.message !== "string") {
		return undefined;
	}
	let body: unknown;
	try {
		body = JSON.parse(options.message);
	} catch {
		// A frame this build cannot read is the session's own refusal, in its own words.
		return undefined;
	}
	const refusal = await refusalFor({
		body: isRecord(body) && body["type"] === "command" ? body : undefined,
		budget: options.budget,
		cap: options.cap,
		day: options.day,
	});
	return refusal === undefined ? undefined : JSON.stringify(refusal.frame);
}
