/**
 * Cassettes: a real exchange, recorded once and replayed free (decision 65).
 *
 * A live run records what it sent and what came back, with auth headers and
 * key-shaped strings removed at record time, so the file can be committed. CI
 * replays it as a `fetch`, which means the same run is tested against a real
 * provider's bytes with no network and no allowance spent.
 *
 * Everything here is web-standard: the recorder wraps a `fetch` and the replayer
 * is one. Writing the file to disk is the live suite's job, because that needs
 * `node:fs`, which nothing under `src/` may import.
 */

import { isPlainObject } from "../core/json.js";
import { fail, ok, type Result } from "../core/result.js";

/** What a live run sends, with anything secret already removed. */
export interface RecordedRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

export interface RecordedResponse {
	status: number;
	headers: Record<string, string>;
	body: string;
}

export interface RecordedExchange {
	request: RecordedRequest;
	response: RecordedResponse;
}

export interface Cassette {
	/** Why this file exists, and whether it came from a real call or a fake one. */
	note?: string;
	exchanges: RecordedExchange[];
}

/** What `fetch` is called with, spelled here so this file needs no platform type. */
export interface CassetteFetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

/** Headers that carry a credential, whatever the provider calls them. */
const SECRET_HEADERS = new Set([
	"authorization",
	"x-api-key",
	"api-key",
	"x-auth-token",
	"cookie",
	"set-cookie",
]);

/** What a key or a token looks like in a body: long, random and distinctive. */
const SECRET_PATTERNS: readonly { name: string; pattern: RegExp }[] = [
	{ name: "an sk- key", pattern: /\bsk-[A-Za-z0-9_-]{12,}/ },
	{ name: "a bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/ },
	{ name: "a long base64 run", pattern: /[A-Za-z0-9+/]{60,}={0,2}/ },
	{ name: "a long hex run", pattern: /\b[0-9a-f]{48,}\b/ },
	{ name: "an OpenRouter or OpenCode key shape", pattern: /\b(?:or|oc)-v1-[A-Za-z0-9-]{12,}/ },
];

export interface SecretHit {
	/** What it looked like: `an sk- key`, a supplied key's name, or a pattern's name. */
	what: string;
	/** Where it was found, so a failure names the file and the field. */
	where: string;
}

/**
 * Every key-shaped string in a text, with the exact values a caller names. The
 * check is deliberately blunt: a false positive costs a re-record, and a false
 * negative puts a key in a public repository.
 */
export function scanForSecrets(
	text: string,
	options: { keys?: readonly { name: string; value: string }[] } = {},
): SecretHit[] {
	const hits: SecretHit[] = [];
	for (const { name, pattern } of SECRET_PATTERNS) {
		if (pattern.test(text)) {
			hits.push({ what: name, where: "the text" });
		}
	}
	for (const key of options.keys ?? []) {
		if (key.value !== "" && text.includes(key.value)) {
			hits.push({ what: `the value of ${key.name}`, where: "the text" });
		}
	}
	return hits;
}

/** A recorded exchange with its credentials taken out, ready to be committed. */
export function scrubExchange(exchange: RecordedExchange): RecordedExchange {
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(exchange.request.headers)) {
		if (SECRET_HEADERS.has(name.toLowerCase())) {
			continue;
		}
		headers[name.toLowerCase()] = value;
	}
	return {
		request: { ...exchange.request, headers },
		response: {
			...exchange.response,
			headers: Object.fromEntries(
				Object.entries(exchange.response.headers).map(([name, value]) => [
					name.toLowerCase(),
					value,
				]),
			),
		},
	};
}

function stringRecord(value: unknown, where: string): Result<Record<string, string>> {
	if (value === undefined) {
		return ok({});
	}
	if (!isPlainObject(value)) {
		return fail("bad_request", `${where} must be an object of strings`);
	}
	const record: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "string") {
			return fail("bad_request", `${where}.${key} must be a string`);
		}
		record[key] = entry;
	}
	return ok(record);
}

function textOf(value: Record<string, unknown>, key: string, where: string): Result<string> {
	const field = value[key];
	if (typeof field !== "string") {
		return fail("bad_request", `${where}.${key} must be a string`);
	}
	return ok(field);
}

/** A cassette from a parsed JSON file, refused with the field that is wrong. */
export function decodeCassette(value: unknown): Result<Cassette> {
	if (!isPlainObject(value)) {
		return fail("bad_request", "a cassette must be an object");
	}
	const exchanges = value["exchanges"];
	if (!Array.isArray(exchanges)) {
		return fail("bad_request", "a cassette must have an exchanges list");
	}
	const decoded: RecordedExchange[] = [];
	for (const [index, raw] of exchanges.entries()) {
		const where = `exchanges[${index}]`;
		if (!isPlainObject(raw)) {
			return fail("bad_request", `${where} must be an object`);
		}
		const rawRequest = raw["request"];
		const rawResponse = raw["response"];
		if (!isPlainObject(rawRequest)) {
			return fail("bad_request", `${where}.request must be an object`);
		}
		if (!isPlainObject(rawResponse)) {
			return fail("bad_request", `${where}.response must be an object`);
		}
		const url = textOf(rawRequest, "url", `${where}.request`);
		if (!url.ok) {
			return url;
		}
		const method = textOf(rawRequest, "method", `${where}.request`);
		if (!method.ok) {
			return method;
		}
		const body = textOf(rawRequest, "body", `${where}.request`);
		if (!body.ok) {
			return body;
		}
		const headers = stringRecord(rawRequest["headers"], `${where}.request.headers`);
		if (!headers.ok) {
			return headers;
		}
		const responseBody = textOf(rawResponse, "body", `${where}.response`);
		if (!responseBody.ok) {
			return responseBody;
		}
		const responseHeaders = stringRecord(rawResponse["headers"], `${where}.response.headers`);
		if (!responseHeaders.ok) {
			return responseHeaders;
		}
		const status = rawResponse["status"];
		if (typeof status !== "number" || !Number.isSafeInteger(status)) {
			return fail("bad_request", `${where}.response.status must be a whole number`);
		}
		decoded.push({
			request: {
				url: url.value,
				method: method.value,
				headers: headers.value,
				body: body.value,
			},
			response: {
				status,
				headers: responseHeaders.value,
				body: responseBody.value,
			},
		});
	}
	const cassette: Cassette = { exchanges: decoded };
	const note = value["_note"];
	if (typeof note === "string") {
		cassette.note = note;
	}
	return ok(cassette);
}

export function encodeCassette(cassette: Cassette): string {
	// The note goes first in the file, because it is what a reader needs first.
	const value =
		cassette.note === undefined
			? { exchanges: cassette.exchanges }
			: { _note: cassette.note, exchanges: cassette.exchanges };
	return `${JSON.stringify(value, null, "\t")}\n`;
}

/** Two JSON bodies are the same request when they parse to the same value. */
function sameBody(left: string, right: string): boolean {
	if (left === right) {
		return true;
	}
	try {
		return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
	} catch {
		return false;
	}
}

export interface CassetteReplay {
	(url: string, init?: CassetteFetchInit): Promise<Response>;
	/** Exchanges nothing has asked for yet, which a test can assert is none. */
	unused(): RecordedExchange[];
}

/**
 * A cassette as a `fetch`. A request is matched to the first unused exchange with
 * the same method, URL and body, so a retried turn replays its own recording. A
 * request with no exchange is a loud failure rather than a quiet call to the
 * network, because a test that silently reached a provider would pass for the
 * wrong reason and cost money.
 */
export function replayCassette(cassette: Cassette): CassetteReplay {
	const exchanges = cassette.exchanges.map((exchange) => ({ exchange, used: false }));

	const replay = async (url: string, init?: CassetteFetchInit): Promise<Response> => {
		const method = init?.method ?? "GET";
		const body = init?.body ?? "";
		const match = exchanges.find(
			(candidate) =>
				!candidate.used &&
				candidate.exchange.request.url === url &&
				candidate.exchange.request.method.toUpperCase() === method.toUpperCase() &&
				sameBody(candidate.exchange.request.body, body),
		);
		if (match === undefined) {
			throw new Error(
				`the cassette has no exchange for ${method.toUpperCase()} ${url}: record it again with pnpm test:live, or fix the request the test sends`,
			);
		}
		match.used = true;
		return new Response(match.exchange.response.body, {
			status: match.exchange.response.status,
			headers: match.exchange.response.headers,
		});
	};

	return Object.assign(replay, {
		unused: () => exchanges.filter((candidate) => !candidate.used).map((c) => c.exchange),
	});
}

export interface RecordingFetch {
	(url: string, init?: CassetteFetchInit): Promise<Response>;
	/** Every exchange so far, already scrubbed. */
	exchanges: RecordedExchange[];
	cassette(): Cassette;
}

/**
 * A `fetch` that records what it was asked and what came back, scrubbed as it
 * goes: auth headers are dropped and the body's text is kept as it is, because a
 * cassette is worth nothing if it cannot be read.
 */
export function recordingFetch(
	inner: (url: string, init?: CassetteFetchInit) => Promise<Response>,
	options: { note?: string } = {},
): RecordingFetch {
	const exchanges: RecordedExchange[] = [];

	const record = async (url: string, init?: CassetteFetchInit): Promise<Response> => {
		const response = await inner(url, init);
		// The body is read here and handed on, because a response can be read once.
		const body = await response.text();
		exchanges.push(
			scrubExchange({
				request: {
					url,
					method: init?.method ?? "GET",
					headers: { ...init?.headers },
					body: init?.body ?? "",
				},
				response: {
					status: response.status,
					headers: Object.fromEntries([...response.headers]),
					body,
				},
			}),
		);
		return new Response(body, { status: response.status, headers: response.headers });
	};

	return Object.assign(record, {
		exchanges,
		cassette: (): Cassette =>
			options.note === undefined
				? { exchanges: [...exchanges] }
				: { note: options.note, exchanges: [...exchanges] },
	});
}
