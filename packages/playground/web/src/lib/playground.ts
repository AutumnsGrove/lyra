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

/** One counter for every frame id the page makes, so two in a millisecond differ. */
let idCounter = 0;

/**
 * A frame id for a command or an answer.
 *
 * `Date.now()` alone can repeat within a millisecond, and a host that dedupes on the id
 * would drop the second frame silently; the counter is what makes two answers in the same
 * tick two frames (found in review on #96).
 */
export function nextId(prefix: string): string {
	idCounter += 1;
	return `${prefix}${Date.now()}-${idCounter}`;
}

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
	/** The conversation to start in, when the page already holds its id. */
	session?: string;
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
				id: nextId("c"),
				command: "start",
				task: options.task,
				input: options.input,
				...(options.session === undefined ? {} : { session: options.session }),
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
 * Read one server-sent-event block: its event, when it has a `data:` line, and the
 * entry position it came from.
 *
 * The dialect is the protocol's own: one `data:` line per event, an `id:` naming the
 * entry the event came from, comments ignored. The id is kept because a stream that
 * drops reopens with `Last-Event-ID` and gets only what it missed (HTP05), and a live
 * event has no id, which is what tells a replayed event from a delta.
 */
function readBlock(block: string): { event?: StreamEvent; id?: string } {
	const data: string[] = [];
	let id: string | undefined;
	for (const line of block.split("\n")) {
		if (line.startsWith(":")) {
			continue;
		}
		if (line.startsWith("id:")) {
			const value = line.slice("id:".length).trim();
			if (value !== "") {
				id = value;
			}
			continue;
		}
		if (line.startsWith("data:")) {
			data.push(line.slice("data:".length).trimStart());
		}
	}
	const joined = data.join("\n");
	if (joined.trim() === "") {
		return id === undefined ? {} : { id };
	}
	try {
		const value: unknown = JSON.parse(joined);
		return isRecord(value) ? { event: value, ...(id === undefined ? {} : { id }) } : {};
	} catch {
		// A half-written line is not a page's problem to report: the stream is the
		// server's, and one unreadable event must not stop the ones after it.
		return id === undefined ? {} : { id };
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
	/** Where to resume: the last entry position the page drew (HTP05). */
	lastEventId?: string;
	onEvent: (event: StreamEvent) => void;
}): Promise<{ ok: true; lastEventId?: string } | { ok: false; error: Refusal }> {
	let response: Response;
	try {
		response = await options.fetcher(
			`${options.base}/v1/events?session=${encodeURIComponent(options.session)}`,
			{
				method: "GET",
				headers: {
					authorization: `Bearer ${options.token}`,
					accept: "text/event-stream",
					...(options.lastEventId === undefined
						? {}
						: { "last-event-id": options.lastEventId }),
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
	// The last position the stream gave this reader, reported so a caller can reopen
	// without asking for the record from the beginning again.
	let lastEventId = options.lastEventId;
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
				const read = readBlock(block);
				if (read.id !== undefined) {
					lastEventId = read.id;
				}
				if (read.event !== undefined) {
					options.onEvent(read.event);
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
	return { ok: true, ...(lastEventId === undefined ? {} : { lastEventId }) };
}

/**
 * One command that is not a `start`: a steer, a follow-up or a stop.
 *
 * They answer with the protocol's own response frame, so a refusal keeps its code and
 * status and the page can tell `conflict` (nothing to steer) from a wrong token.
 */
export async function sendCommand(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	command: "steer" | "follow_up" | "abort";
	session: string;
	text?: string;
	id: string;
}): Promise<{ ok: true } | { ok: false; error: Refusal }> {
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
				id: options.id,
				command: options.command,
				session: options.session,
				...(options.text === undefined ? {} : { text: options.text }),
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
	return { ok: true };
}

/**
 * The record's entries, one page at a time (CMD11, CMD12).
 *
 * The panel asks for a page and follows the cursor, so a long record never arrives as
 * one reply. The cursor is the id of the last entry the page holds, which is what the
 * protocol's own paging names.
 */
export interface RecordPage {
	entries: Record<string, unknown>[];
	cursor: string | null;
}

export async function readRecord(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	session: string;
	cursor?: string | null;
	limit?: number;
	id: string;
}): Promise<{ ok: true; value: RecordPage } | { ok: false; error: Refusal }> {
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
				id: options.id,
				command: "get_messages",
				session: options.session,
				...(options.limit === undefined ? {} : { limit: options.limit }),
				...(options.cursor === undefined || options.cursor === null
					? {}
					: { cursor: options.cursor }),
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
	if (!isRecord(frame.data) || !Array.isArray(frame.data["entries"])) {
		return {
			ok: false,
			error: {
				code: "internal",
				message: "the answer had no entries",
				status: response.status,
			},
		};
	}
	const entries = frame.data["entries"].filter(isRecord);
	const cursor = frame.data["cursor"];
	return {
		ok: true,
		value: {
			entries,
			cursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
		},
	};
}

/** One line the transcript draws. */
export type Row =
	| { kind: "person"; text: string }
	| { kind: "assistant"; text: string; reasoning?: string }
	/**
	 * One call, from the model's reply to its result (issue #60, slice 4).
	 *
	 * A call is one row that fills in rather than two rows a page has to pair up: several
	 * calls in a group arrive before any result does, and a result that arrived as its own
	 * row would draw the group twice. `at` is the record entry's own time, so a duration
	 * is the record's number and not the page's clock: a live run and a rebuild agree.
	 */
	| {
			kind: "tool";
			name: string;
			callId: string;
			arguments?: string;
			at?: number;
			result?: string;
			isError?: boolean;
			durationMs?: number;
	  }
	/**
	 * A person's card: an approval, a question or a choice (issue #60, slice 6).
	 *
	 * One row that fills in, like a call: the request arrives, the person answers (or
	 * another client does), and the same row says what was decided. A card and its answer
	 * as two rows would draw the question twice.
	 */
	| {
			kind: "card";
			request: string;
			asks: RequestKind;
			title: string;
			message: string;
			tool?: string;
			args?: string;
			options?: { id: string; label: string }[];
			state: CardState;
			/** What the person said, when there was something to say. */
			answer?: string;
	  }
	/** A finished run's result for a person to decide (decision 52). */
	| {
			kind: "proposal";
			proposal: string;
			/** The payload as JSON text, because it is the task's shape and not the page's. */
			payload: string;
			evidence: string[];
			state: "open" | "accepted" | "rejected";
			note?: string;
	  }
	| { kind: "problem"; text: string };

export type RequestKind = "approve" | "question" | "choice";
export type CardState = "open" | "approved" | "denied" | "expired";

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

/** What a call's own badge says, which depends on the run as well as the row. */
export type CallState = "running" | "done" | "error" | "unfinished";

/**
 * A call row's state, given the run's.
 *
 * A row with no result is only "running" while the run is: after a stop, a kill or a
 * reload of a finished run, the honest word is "unfinished", because the page knows the
 * result is never coming (found in review on #89).
 */
export function callState(row: Row, run: Status["state"]): CallState {
	if (row.kind !== "tool") {
		return "unfinished";
	}
	if (row.result === undefined) {
		return run === "running" ? "running" : "unfinished";
	}
	return row.isError === true ? "error" : "done";
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function requestKindOf(value: unknown): RequestKind | undefined {
	return value === "approve" || value === "question" || value === "choice" ? value : undefined;
}

function optionsOf(value: unknown): { id: string; label: string }[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	const options: { id: string; label: string }[] = [];
	for (const option of value) {
		if (!isRecord(option)) {
			continue;
		}
		const id = stringOf(option["id"]);
		const label = stringOf(option["label"]);
		if (id !== undefined && label !== undefined) {
			options.push({ id, label });
		}
	}
	return options.length === 0 ? undefined : options;
}

/** A proposal's payload as the page can draw it: the task's JSON, as text. */
function payloadOf(value: unknown): string {
	return JSON.stringify(value) ?? "null";
}

function evidenceOf(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return value.map((item) => (typeof item === "string" ? item : JSON.stringify(item)));
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
			// The call's own entry time, which is what a result measures its duration
			// against: several calls in a group share it, because they share the entry.
			const at = numberOf(event["ts"]);
			return {
				...state,
				rows: [
					...state.rows,
					{
						kind: "tool",
						name,
						callId,
						...(args === undefined ? {} : { arguments: args }),
						...(at === undefined ? {} : { at }),
					},
				],
			};
		}
		case "tool_end": {
			const callId = stringOf(event["callId"]) ?? "";
			const text = stringOf(event["content"]) ?? "";
			const isError = event["isError"] === true;
			const endedAt = numberOf(event["ts"]);
			// The call's row, not a new one: the call and its result are the same row, so a
			// group of calls is one list and a result cannot be drawn before its call.
			let matched = false;
			const rows = state.rows.map((row) => {
				// The first unanswered row for this call, and no other: a result the page
				// already drew is not overwritten by a later one (found while building
				// slice 4, where the row is the call and the result both).
				if (
					matched ||
					row.kind !== "tool" ||
					row.callId !== callId ||
					row.result !== undefined
				) {
					return row;
				}
				matched = true;
				const durationMs =
					endedAt === undefined || row.at === undefined ? undefined : endedAt - row.at;
				return {
					...row,
					result: text,
					isError,
					...(durationMs === undefined ? {} : { durationMs }),
				};
			});
			return matched ? { ...state, rows } : state;
		}
		case "ui_request": {
			const request = stringOf(event["request"]);
			const asks = requestKindOf(event["kind"]);
			if (request === undefined || asks === undefined) {
				return state;
			}
			const tool = stringOf(event["tool"]);
			const args = stringOf(event["args"]);
			const options = optionsOf(event["options"]);
			return {
				...state,
				rows: [
					...state.rows,
					{
						kind: "card",
						request,
						asks,
						title: stringOf(event["title"]) ?? "the run needs you",
						message: stringOf(event["message"]) ?? "",
						...(tool === undefined ? {} : { tool }),
						...(args === undefined ? {} : { args }),
						...(options === undefined ? {} : { options }),
						state: "open",
					},
				],
			};
		}
		case "ui_resolved": {
			const request = stringOf(event["request"]);
			if (request === undefined) {
				return state;
			}
			const decision = event["decision"] === "approve" ? "approved" : "denied";
			const note = stringOf(event["note"]);
			return {
				...state,
				rows: state.rows.map((row) =>
					row.kind === "card" && row.request === request && row.state === "open"
						? {
								...row,
								state: decision,
								...(note === undefined ? {} : { answer: note }),
							}
						: row,
				),
			};
		}
		case "ui_expired": {
			const request = stringOf(event["request"]);
			if (request === undefined) {
				return state;
			}
			return {
				...state,
				rows: state.rows.map((row) =>
					row.kind === "card" &&
					row.request === request &&
					// A timeout is projected as `ui_resolved` (deny) and then `ui_expired`
					// (events.ts), so this has to correct the deny it just wrote; nothing
					// else sends an expired event for a card that was answered.
					(row.state === "open" || row.state === "denied")
						? { ...row, state: "expired" }
						: row,
				),
			};
		}
		case "proposal": {
			const proposal = stringOf(event["proposal"]);
			if (proposal === undefined) {
				return state;
			}
			return {
				...state,
				rows: [
					...state.rows,
					{
						kind: "proposal",
						proposal,
						payload: payloadOf(event["payload"]),
						evidence: evidenceOf(event["evidence"]),
						state: "open",
					},
				],
			};
		}
		case "proposal_decided": {
			const proposal = stringOf(event["proposal"]);
			if (proposal === undefined) {
				return state;
			}
			const decision = event["decision"] === "accept" ? "accepted" : "rejected";
			const note = stringOf(event["note"]);
			return {
				...state,
				rows: state.rows.map((row) =>
					row.kind === "proposal" && row.proposal === proposal && row.state === "open"
						? { ...row, state: decision, ...(note === undefined ? {} : { note }) }
						: row,
				),
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

/** One POST to the protocol's surface, with the frame's answer decoded the same way. */
async function postFrame(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	path: string;
	frame: Record<string, unknown>;
}): Promise<{ ok: true; data: unknown } | { ok: false; error: Refusal }> {
	let response: Response;
	try {
		response = await options.fetcher(`${options.base}${options.path}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer ${options.token}`,
				"x-lyra-version": "1",
			},
			body: JSON.stringify(options.frame),
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
	return { ok: true, data: frame.data };
}

/**
 * Answer a request: an approval's yes or no, a question's text, or a choice's ids.
 *
 * One frame, because that is the whole of what an answer is. The refusals are what a page
 * has to draw honestly: `conflict` is a second answer (somebody got there first),
 * `not_found` is an id that expired, and both mean the card should close rather than
 * nag.
 */
export async function answerRequest(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	session: string;
	request: string;
	ok: boolean;
	note?: string;
	text?: string;
	ids?: string[];
	id: string;
}): Promise<{ ok: true } | { ok: false; error: Refusal }> {
	const answered = await postFrame({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: "/v1/ui_response",
		frame: {
			type: "ui_response",
			id: options.id,
			request: options.request,
			session: options.session,
			ok: options.ok,
			...(options.note === undefined ? {} : { note: options.note }),
			...(options.text === undefined ? {} : { text: options.text }),
			...(options.ids === undefined ? {} : { ids: options.ids }),
		},
	});
	return answered.ok ? { ok: true } : answered;
}

/** Decide a proposal: accept or reject, with the note the model would read. */
export async function decideProposal(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	session: string;
	proposal: string;
	decision: "accept" | "reject";
	note?: string;
	id: string;
}): Promise<{ ok: true } | { ok: false; error: Refusal }> {
	const decided = await postFrame({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: "/v1/commands",
		frame: {
			type: "command",
			id: options.id,
			command: "decide_proposal",
			proposal: options.proposal,
			decision: options.decision,
			...(options.note === undefined ? {} : { note: options.note }),
			session: options.session,
		},
	});
	return decided.ok ? { ok: true } : decided;
}

/**
 * The cards a session can answer right now (CMD09).
 *
 * The record already holds every request, so a rebuild shows them; this is the other
 * half, and the one that matters when the page's record read stopped at its page cap or
 * the object was rebuilt under it: the server is asked what can be answered *now*.
 */
export async function pendingCards(options: {
	base: string;
	token: string;
	fetcher: Fetcher;
	session: string;
	id: string;
}): Promise<{ ok: true; value: { cards: Row[] } } | { ok: false; error: Refusal }> {
	const listed = await postFrame({
		base: options.base,
		token: options.token,
		fetcher: options.fetcher,
		path: "/v1/commands",
		frame: {
			type: "command",
			id: options.id,
			command: "list_pending",
			session: options.session,
		},
	});
	if (!listed.ok) {
		return listed;
	}
	const data = isRecord(listed.data) ? listed.data : undefined;
	const requests = data?.["requests"];
	const proposals = data?.["proposals"];
	if (!Array.isArray(requests) || !Array.isArray(proposals)) {
		return {
			ok: false,
			error: { code: "internal", message: "the answer had no pending list", status: 200 },
		};
	}

	const cards: Row[] = [];
	for (const entry of requests) {
		if (!isRecord(entry)) {
			continue;
		}
		const request = stringOf(entry["request"]);
		const asks = requestKindOf(entry["kind"]);
		if (request === undefined || asks === undefined) {
			continue;
		}
		const tool = stringOf(entry["tool"]);
		const args = stringOf(entry["args"]);
		const options = optionsOf(entry["options"]);
		cards.push({
			kind: "card",
			request,
			asks,
			title: stringOf(entry["title"]) ?? "the run needs you",
			message: stringOf(entry["message"]) ?? "",
			...(tool === undefined ? {} : { tool }),
			...(args === undefined ? {} : { args }),
			...(options === undefined ? {} : { options }),
			state: "open",
		});
	}
	for (const entry of proposals) {
		if (!isRecord(entry)) {
			continue;
		}
		const proposal = stringOf(entry["proposal"]);
		if (proposal === undefined) {
			continue;
		}
		cards.push({
			kind: "proposal",
			proposal,
			payload: payloadOf(entry["payload"]),
			evidence: evidenceOf(entry["evidence"]),
			state: "open",
		});
	}
	return { ok: true, value: { cards } };
}

/** What a `run_end` adds to the day's spend, or nothing when it adds nothing. */
export interface SpendReport {
	run: string;
	/** The dollars this end adds over the last total reported for the run. */
	amount?: number;
	/** The run made a model call and reported no cost, so the day can no longer be priced. */
	unpriced?: boolean;
}

/**
 * The spend a `run_end` reports, given what has already been counted for that run.
 *
 * A `run_end` reports the whole run's usage rather than the segment it ended, so a run that
 * parks and resumes sends a cumulative total each time: what is due is the difference from
 * the last one, which is also why a replayed end adds nothing. A run that never made a model
 * call has no cost and needs no price — marking the day unpriced for it would let a free
 * failure latch the cap for the rest of the day.
 */
export function spendOf(event: StreamEvent, last: number | undefined): SpendReport | undefined {
	if (event["type"] !== "run_end") {
		return undefined;
	}
	const run = stringOf(event["run"]);
	if (run === undefined) {
		return undefined;
	}
	const usage = event["usage"];
	if (!isRecord(usage)) {
		return undefined;
	}
	const cost = usage["cost"];
	const amount = isRecord(cost) ? numberOf(cost["amount"]) : undefined;
	const inputTokens = numberOf(usage["inputTokens"]) ?? 0;
	const outputTokens = numberOf(usage["outputTokens"]) ?? 0;

	if (amount === undefined) {
		// Nothing to price and nothing that needed a price: a run that failed or was stopped
		// before its first reply.
		return inputTokens === 0 && outputTokens === 0 ? undefined : { run, unpriced: true };
	}
	const delta = amount - (last ?? 0);
	return delta > 0 ? { run, amount: delta } : undefined;
}
