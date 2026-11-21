/**
 * How a provider's failure becomes a `ModelError` (docs/adapters.md, OAI20 to
 * OAI23).
 *
 * Step 2's retries trust `retryable`, so it has to be right: a transient outage
 * is tried again and then parks the run for a person, and a request the provider
 * will never accept fails it at once. Messages are cut to a length a record can
 * hold, and they never carry a request header, so a key cannot leave this way.
 */

import { isPlainObject } from "../../core/json.js";
import type { ModelError } from "../../core/model.js";
import type { ErrorCode } from "../../core/result.js";

/** The statuses worth trying again: the provider is busy, not the request wrong. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** A provider's own code, when it says something permanent rather than loading. */
const PERMANENT_STATUSES = new Set([400, 401, 403, 404, 422]);

/** However long a provider asks for, five minutes is the most it may ask. */
export const MAX_RETRY_AFTER_MS = 300_000;

/** How much of a provider's own text a message may carry. */
export const MAX_MESSAGE_CHARS = 300;

export function isRetryableStatus(status: number): boolean {
	return RETRYABLE_STATUSES.has(status);
}

/** The error code a status deserves. Anything unknown is a provider failure. */
export function codeForStatus(status: number): ErrorCode {
	switch (status) {
		case 400:
		case 422:
			return "bad_request";
		case 401:
		case 403:
			return "permission_denied";
		case 404:
			return "not_found";
		case 408:
			return "timeout";
		case 409:
			return "conflict";
		case 429:
			return "busy";
		default:
			return "provider_error";
	}
}

export function truncateMessage(text: string): string {
	const trimmed = text.trim();
	return trimmed.length > MAX_MESSAGE_CHARS ? `${trimmed.slice(0, MAX_MESSAGE_CHARS)}…` : trimmed;
}

/**
 * `Retry-After` as a wait in milliseconds: seconds, or an HTTP date, capped and
 * never negative. A value this cannot read is no guidance at all.
 */
export function retryAfterMs(header: string | null, now: number): number | undefined {
	if (header === null) {
		return undefined;
	}
	const value = header.trim();
	if (value === "") {
		return undefined;
	}
	if (/^\d+$/.test(value)) {
		return Math.min(Number(value) * 1_000, MAX_RETRY_AFTER_MS);
	}
	const at = Date.parse(value);
	if (Number.isNaN(at)) {
		return undefined;
	}
	return Math.min(Math.max(at - now, 0), MAX_RETRY_AFTER_MS);
}

/** The provider's own words about a failure, when its body is an error object. */
export function errorFromJsonBody(text: string): ModelError | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (!isPlainObject(parsed)) {
		return undefined;
	}
	const raw = parsed["error"];
	if (raw === undefined) {
		return undefined;
	}
	const message =
		isPlainObject(raw) && typeof raw["message"] === "string"
			? raw["message"]
			: typeof raw === "string"
				? raw
				: "the provider reported an error";
	const code = isPlainObject(raw) && typeof raw["code"] === "number" ? raw["code"] : 0;
	return {
		code: "provider_error",
		message: truncateMessage(message),
		retryable: !PERMANENT_STATUSES.has(code),
	};
}

/**
 * A failure that came back with a status. The body is the provider's own
 * explanation when it has one, in JSON or in plain text, and it is the only
 * thing about the response that reaches the message.
 */
export function errorForStatus(
	status: number,
	body: string,
	options: { retryAfter?: string | null; now: number },
): ModelError {
	const explained = errorFromJsonBody(body);
	const reason =
		explained !== undefined ? explained.message : truncateMessage(body === "" ? "" : body);
	const error: ModelError = {
		code: codeForStatus(status),
		message: truncateMessage(
			reason === ""
				? `the model provider answered ${status}`
				: `the model provider answered ${status}: ${reason}`,
		),
		retryable: isRetryableStatus(status),
	};
	const wait = retryAfterMs(options.retryAfter ?? null, options.now);
	if (wait !== undefined) {
		error.retryAfterMs = wait;
	}
	return error;
}
