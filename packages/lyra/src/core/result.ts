/**
 * Failure is data (docs/core-loop.md, "Failure is a value").
 *
 * Nothing in the core throws across a module boundary. A function that can fail
 * returns a `Result`, and the caller has to look at it, so a model error, a
 * failed save or a dead tool cannot take the loop down by surprise.
 */

/**
 * Nova's eight stable codes, plus `conflict` (decision 83) and `limit` (decision 160).
 *
 * `limit` is the host's: it refuses work because a limit the host enforces — a day's
 * spend, a tenant's quota — has been reached. It is not a run parked on the core's own
 * limit, which is a `parked` status with a limit's detail and is not an error at all.
 */
export const ERROR_CODES = [
	"bad_request",
	"busy",
	"not_found",
	"permission_denied",
	"unsupported",
	"timeout",
	"provider_error",
	"internal",
	"conflict",
	"limit",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export function isErrorCode(value: unknown): value is ErrorCode {
	return ERROR_CODES.some((code) => code === value);
}

export interface LyraError {
	code: ErrorCode;
	message: string;
}

export type Result<T, E = LyraError> = { ok: true; value: T } | { ok: false; error: E };

/** The success half, spelled out so its type stays narrow. */
export function ok<T>(value: T): { ok: true; value: T } {
	return { ok: true, value };
}

/** The failure half. */
export function err<E>(error: E): { ok: false; error: E } {
	return { ok: false, error };
}

/** A failure with a code, which is the common case. */
export function fail(code: ErrorCode, message: string): { ok: false; error: LyraError } {
	return err({ code, message });
}
