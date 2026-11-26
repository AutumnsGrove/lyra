/**
 * The page's own client logic (issue #60, slice 2).
 *
 * Everything here is plain TypeScript with its dependencies passed in — `fetch`, the
 * storage, the clock — so the parts a person depends on (the token, the command, the
 * stream, the transcript) are tested on Node without a browser. The Svelte components are
 * a thin skin over this file, which is why they can stay thin.
 *
 * The protocol is the published one: `POST /v1/commands` with one frame, `GET /v1/events`
 * as server-sent events for a named session. Nothing here invents a field.
 */

/** Where the bearer lives, so a person types it once. */
export const TOKEN_KEY = "lyra-playground-token";

/** The storage the page uses, narrowed to the three calls it makes. */
export interface TokenStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	removeItem(key: string): void;
}

/** The slice of `fetch` the page calls. */
export type Fetcher = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<Response>;

export function readToken(storage: TokenStorage): string | undefined {
	const value = storage.getItem(TOKEN_KEY);
	return typeof value === "string" && value !== "" ? value : undefined;
}

export function saveToken(storage: TokenStorage, token: string): void {
	const trimmed = token.trim();
	if (trimmed === "") {
		return;
	}
	storage.setItem(TOKEN_KEY, trimmed);
}

export function clearToken(storage: TokenStorage): void {
	storage.removeItem(TOKEN_KEY);
}

/** What the page needs from a run it just started. */
export interface Started {
	session: string;
	run: string;
}

export interface Refusal {
	code: string;
	message: string;
	/** The HTTP status, which is what tells a refusal apart from a bad request. */
	status: number;
}

export type StartedResult = { ok: true; value: Started } | { ok: false; error: Refusal };

/** One command frame's answer, which is the only shape the command surface returns. */
interface ResponseFrame {
	type?: unknown;
	ok?: unknown;
	data?: unknown;
	error?: { code?: unknown; message?: unknown };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Start a run, and hand back the session and run it opened.
 *
 * A refusal keeps its status as well as its code: the page has to tell a wrong token
 * (`permission_denied`, 403) from a bad request, and it is the 403 that clears the token
 * box rather than leaving a person typing into a token that will never work.
 */
export async function startRun(options: {
	base: string;
	token: string;
	task: string;
	input: string;
	fetcher: Fetcher;
	key?: string;
}): Promise<StartedResult> {
	let response: Response;
	try {
		response = await options.fetcher(`${options.base}/v1/commands`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.token}`,
				"x-lyra-version": "1",
			},
			body: JSON.stringify({
				type: "command",
				id: `c${Date.now()}`,
				command: "start",
				task: options.task,
				input: options.input,
				...(options.key === undefined ? {} : { key: options.key }),
			}),
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

	const body: unknown = await response.json().catch(() => undefined);
	const frame: ResponseFrame = isRecord(body) ? body : {};
	if (!response.ok || frame.ok !== true) {
		const code =
			isRecord(frame.error) && typeof frame.error.code === "string"
				? frame.error.code
				: "internal";
		const message =
			isRecord(frame.error) && typeof frame.error.message === "string"
				? frame.error.message
				: `the server answered ${response.status}`;
		return { ok: false, error: { code, message, status: response.status } };
	}

	const data = frame.data;
	if (!isRecord(data) || typeof data["session"] !== "string" || typeof data["run"] !== "string") {
		return {
			ok: false,
			error: {
				code: "internal",
				message: "the answer had no session and run",
				status: response.status,
			},
		};
	}
	return { ok: true, value: { session: data["session"], run: data["run"] } };
}

/** One event the page draws, as the protocol sends it. */
export type StreamEvent = Record<string, unknown>;

/**
 * Read one server-sent-event block, or nothing when it has no data line.
 *
 * The dialect is the protocol's own: one `data:` line per event, an `id:` naming the
 * entry the event came from, comments ignored. The id is dropped because a page that
 * reloads rebuilds from the record (slice 3) rather than from a resumed stream.
 */
function readBlock(block: string): StreamEvent | undefined {
	const data: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).trimStart());
		}
	}
	if (data.length === 0) {
		return undefined;
	}
	const joined = data.join("\n");
	if (joined.trim() === "") {
		return undefined;
	}
	try {
		const value: unknown = JSON.parse(joined);
		return isRecord(value) ? value : undefined;
	} catch {
		// A half-written line is not a page's problem to report: the stream is the
		// server's, and one unreadable event must not stop the ones after it.
		return undefined;
	}
}

/**
 * Follow a session's events until the stream ends or the caller stops it.
 *
 * Reading the body rather than an `EventSource` is deliberate: it takes the bearer in a
 * header, which an `EventSource` cannot send, and it means the whole path is a `fetch`
 * a test can drive with a scripted body.
 */
export async function watchEvents(options: {
	base: string;
	token: string;
	session: string;
	fetcher: Fetcher;
	signal: AbortSignal;
	onEvent: (event: StreamEvent) => void;
}): Promise<{ ok: true } | { ok: false; error: Refusal }> {
	let response: Response;
	try {
		response = await options.fetcher(
			`${options.base}/v1/events?session=${encodeURIComponent(options.session)}`,
			{
				method: "GET",
				headers: {
					authorization: `Bearer ${options.token}`,
					accept: "text/event-stream",
				},
				signal: options.signal,
			},
		);
	} catch (error) {
		// A stop is the caller's own doing, so it is not an error to report.
		if (options.signal.aborted) {
			return { ok: true };
		}
		return {
			ok: false,
			error: {
				code: "network_error",
				message: error instanceof Error ? error.message : "the stream could not be opened",
				status: 0,
			},
		};
	}

	if (!response.ok || response.body === null) {
		let message = `the server answered ${response.status}`;
		try {
			const body: unknown = await response.json();
			if (
				isRecord(body) &&
				isRecord(body["error"]) &&
				typeof body["error"]["message"] === "string"
			) {
				message = body["error"]["message"];
			}
		} catch {
			// Nothing readable, so the status is what the page has to go on.
		}
		return {
			ok: false,
			error: {
				code: response.status === 403 ? "permission_denied" : "stream_error",
				message,
				status: response.status,
			},
		};
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			// Events are separated by a blank line, whatever the line endings.
			buffer = buffer.replace(/\r\n/g, "\n");
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const event = readBlock(block);
				if (event !== undefined) {
					options.onEvent(event);
				}
				boundary = buffer.indexOf("\n\n");
			}
		}
	} catch (error) {
		if (options.signal.aborted) {
			return { ok: true };
		}
		return {
			ok: false,
			error: {
				code: "stream_error",
				message: error instanceof Error ? error.message : "the stream stopped",
				status: 0,
			},
		};
	} finally {
		reader.releaseLock();
	}
	return { ok: true };
}

/** One line the transcript draws. */
export type Row =
	| { kind: "person"; text: string }
	| { kind: "assistant"; text: string; reasoning?: string }
	| { kind: "tool"; name: string; callId: string; arguments?: string }
	| { kind: "result"; name: string; callId: string; text: string; isError: boolean }
	| { kind: "problem"; text: string };

/** What the page shows under the transcript. */
export interface Status {
	state: "idle" | "running" | "done" | "parked" | "failed";
	detail?: string;
	turns?: number;
	/** The model's own cost, when the provider reported one. */
	costUsd?: number;
}

export interface Transcript {
	rows: Row[];
	status: Status;
}

export const EMPTY_TRANSCRIPT: Transcript = { rows: [], status: { state: "idle" } };

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Fold one event into the transcript.
 *
 * Only the events a page can draw are handled; the rest pass through unchanged, which is
 * what keeps this from breaking when the protocol grows a field. The status line comes
 * from `run_end` alone, because that is the one event that says how the run finished.
 */
export function reduce(state: Transcript, event: StreamEvent): Transcript {
	switch (event["type"]) {
		case "message_end": {
			const text = stringOf(event["text"]) ?? "";
			const reasoning = stringOf(event["reasoning"]);
			if (text === "" && reasoning === undefined) {
				return state;
			}
			return {
				...state,
				rows: [
					...state.rows,
					{
						kind: "assistant",
						text,
						...(reasoning === undefined ? {} : { reasoning }),
					},
				],
			};
		}
		case "tool_call": {
			const call = event["call"];
			if (!isRecord(call)) {
				return state;
			}
			const name = stringOf(call["name"]) ?? "tool";
			const callId = stringOf(call["id"]) ?? "";
			const args = stringOf(call["arguments"]);
			return {
				...state,
				rows: [
					...state.rows,
					{
						kind: "tool",
						name,
						callId,
						...(args === undefined ? {} : { arguments: args }),
					},
				],
			};
		}
		case "tool_end": {
			const name = stringOf(event["name"]) ?? "tool";
			const callId = stringOf(event["callId"]) ?? "";
			const text = stringOf(event["content"]) ?? "";
			const isError = event["isError"] === true;
			return {
				...state,
				rows: [...state.rows, { kind: "result", name, callId, text, isError }],
			};
		}
		case "run_end": {
			const reason = stringOf(event["reason"]) ?? "failed";
			const parked = stringOf(event["parkedReason"]);
			const detail = stringOf(event["detail"]);
			const turns = numberOf(event["turn"]);
			const usage = event["usage"];
			const cost =
				isRecord(usage) && isRecord(usage["cost"])
					? numberOf(usage["cost"]["amount"])
					: undefined;
			const next: Status["state"] =
				reason === "done"
					? "done"
					: reason === "parked"
						? "parked"
						: reason === "failed"
							? "failed"
							: "running";
			// The event's own detail already names the cause (`model_unavailable` carries
			// `permission_denied: ...`), so it is shown as it is rather than prefixed with
			// the reason and reading twice.
			const shown = detail ?? parked;
			return {
				rows: state.rows,
				status: {
					state: next,
					...(shown === undefined ? {} : { detail: shown }),
					...(turns === undefined ? {} : { turns }),
					...(cost === undefined ? {} : { costUsd: cost }),
				},
			};
		}
		case "error": {
			const error = event["error"];
			const message =
				isRecord(error) && typeof error["message"] === "string"
					? error["message"]
					: "something went wrong";
			return { ...state, rows: [...state.rows, { kind: "problem", text: message }] };
		}
		default:
			return state;
	}
}
