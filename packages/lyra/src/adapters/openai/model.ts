/**
 * The Model slot, over chat completions (docs/adapters.md, step 5).
 *
 * One adapter for both of Autumn's providers (decision 14): the base URL, the
 * model and the key's name are configuration, so OpenRouter and OpenCode Go are
 * the same code pointed at different addresses. The key is read from a host's
 * Secrets slot by name on every call and never held in this object, so it cannot
 * be logged or recorded by accident. `fetch` and the clock are injected, which is
 * how the fake server and the fake clock reach it.
 *
 * Every failure comes back as a `ModelError`; nothing here throws. A call that a
 * person stopped is an error the loop reads as a stop (it checks its own signal
 * before believing any failure), and a call that ran past its deadline is a
 * retryable timeout.
 */

import type { Clock } from "../../core/clock.js";
import type { ModelError, ModelRequest, ModelReply, ModelSlot } from "../../core/model.js";
import { ok, type Result } from "../../core/result.js";
import type { SecretsSlot } from "../../core/slots.js";
import { errorForStatus, errorFromJsonBody, truncateMessage } from "./errors.js";
import { buildHeaders, buildWireRequest } from "./request.js";
import { readReply } from "./sse.js";

/**
 * The slice of `fetch` this adapter calls. Spelled structurally rather than as
 * `typeof fetch`, so the fake model server, a cassette replay and the platform's
 * own `fetch` all fit without a cast.
 */
export type FetchLike = (
	url: string,
	init?: {
		method?: string;
		headers?: Record<string, string>;
		body?: string;
		signal?: AbortSignal;
	},
) => Promise<Response>;

/** Two minutes, which is longer than any streamed reply should need. */
export const DEFAULT_DEADLINE_MS = 120_000;

export interface OpenAIChatOptions {
	/** The API root, without `/chat/completions`; a trailing slash is ignored. */
	baseUrl: string;
	/** The model id, which a recipe's fallback model overrides (decision 58). */
	model: string;
	secrets: SecretsSlot;
	/** The secret's name. The key itself is never a parameter. */
	keyName: string;
	/** Extra request headers, such as the session OpenCode Go asks for. */
	headers?: Record<string, string>;
	fetch?: FetchLike;
	clock: Clock;
	/** How long one call may take before it is abandoned. */
	deadlineMs?: number;
	/** How many bytes of stream one reply may use. */
	maxBytes?: number;
}

function reasonOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** A message cannot carry the key, even if something underneath echoed it. */
function redact(text: string, secret: string): string {
	return secret === "" ? text : text.split(secret).join("[redacted]");
}

export function createOpenAIChatModel(options: OpenAIChatOptions): ModelSlot {
	const doFetch: FetchLike = options.fetch ?? fetch;
	const clock = options.clock;
	const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
	const endpoint = `${options.baseUrl.replace(/\/+$/, "")}/chat/completions`;

	const stopped = (secret: string): ModelError => ({
		code: "timeout",
		message: redact("the model call was stopped", secret),
		retryable: false,
	});

	return {
		async complete(request: ModelRequest): Promise<Result<ModelReply, ModelError>> {
			if (request.signal.aborted) {
				// Stopped before anything was sent: nothing to clean up and no fetch.
				return { ok: false, error: stopped("") };
			}

			const key = await options.secrets.get(options.keyName);
			if (key === undefined) {
				return {
					ok: false,
					error: {
						code: "permission_denied",
						message: `the secret "${options.keyName}" is not available`,
						retryable: false,
					},
				};
			}

			// A stop can arrive while the secret is being read, and the listener below is
			// added after it, so the signal is read again here: a stop before the request
			// must cost nothing, not one whole stream.
			if (request.signal.aborted) {
				return { ok: false, error: stopped(key) };
			}

			// One controller carries both stops: the caller's, and the deadline's.
			const controller = new AbortController();
			let deadlineReached = false;
			const forward = (): void => controller.abort();
			request.signal.addEventListener("abort", forward, { once: true });
			const deadline = clock.sleep(deadlineMs, controller.signal).then(
				() => {
					deadlineReached = true;
					controller.abort();
				},
				() => undefined,
			);

			const failure = (error: unknown): ModelError => {
				if (request.signal.aborted) {
					return stopped(key);
				}
				if (deadlineReached) {
					return {
						code: "timeout",
						message: `the model did not answer within ${deadlineMs} ms`,
						retryable: true,
					};
				}
				return {
					code: "provider_error",
					message: truncateMessage(
						redact(`the model could not be reached: ${reasonOf(error)}`, key),
					),
					retryable: true,
				};
			};

			try {
				let response: Response;
				try {
					response = await doFetch(endpoint, {
						method: "POST",
						headers: buildHeaders(
							options.headers === undefined
								? { apiKey: key }
								: { apiKey: key, extra: options.headers },
						),
						body: JSON.stringify(buildWireRequest({ request, model: options.model })),
						signal: controller.signal,
					});
				} catch (error) {
					return { ok: false, error: failure(error) };
				}

				if (!response.ok) {
					const body = await textOf(response);
					const error = errorForStatus(response.status, body, {
						retryAfter: response.headers.get("retry-after"),
						now: clock.now(),
					});
					return { ok: false, error: { ...error, message: redact(error.message, key) } };
				}

				// A 200 that is JSON is either the provider's own error object or an answer
				// this adapter cannot read, because it asked for a stream.
				const type = response.headers.get("content-type") ?? "";
				if (type.includes("json") || type.includes("html")) {
					const body = await textOf(response);
					const explained = errorFromJsonBody(body);
					if (explained !== undefined) {
						return {
							ok: false,
							error: { ...explained, message: redact(explained.message, key) },
						};
					}
					return {
						ok: false,
						error: {
							code: "provider_error",
							message: redact(
								truncateMessage(
									`the model provider answered without a stream: ${truncateMessage(body)}`,
								),
								key,
							),
							retryable: false,
						},
					};
				}

				const read = await readReply(
					response.body,
					options.maxBytes === undefined
						? { signal: controller.signal }
						: { signal: controller.signal, maxBytes: options.maxBytes },
				);
				// Stopped as the last chunk arrived is still a stop: the reply is not
				// handed over, because the run is not going to use it (decision 19).
				if (request.signal.aborted) {
					return { ok: false, error: stopped(key) };
				}
				if (deadlineReached) {
					return { ok: false, error: failure(new Error("the deadline passed")) };
				}
				if (!read.ok) {
					return {
						ok: false,
						error: { ...read.error, message: redact(read.error.message, key) },
					};
				}
				return ok(read.value);
			} finally {
				request.signal.removeEventListener("abort", forward);
				// Clears the deadline's sleep, so a fake clock has nothing left waiting.
				controller.abort();
				await deadline;
			}
		},
	};
}

/** A response body as text, without letting a read failure become a throw. */
async function textOf(response: Response): Promise<string> {
	try {
		return await response.text();
	} catch {
		return "";
	}
}
