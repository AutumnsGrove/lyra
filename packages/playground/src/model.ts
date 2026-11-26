/**
 * The model slot a deployment runs (issue #60, slice 2).
 *
 * Slice 1 deployed a placeholder that called `finish` at once, so the door, the object,
 * the record and the protocol could be proved on a real deployment without a key. This
 * file is the switch that puts a real model behind the same seam, and it is the only
 * place in the playground that knows a provider exists.
 *
 * Two names are being bridged here, and they are different on purpose. The OpenAI
 * adapter's preset asks its Secrets slot for `OPENROUTER_API_KEY` by that fixed name,
 * because a preset is configuration and the preset owns the name (docs/adapters.md,
 * OAI30); the Worker's secret is `LYRA_PLAYGROUND_OPENROUTER_API_KEY`, because the shared
 * `gw secret` vault's rule is that a name says which project it belongs to. Renaming the
 * secret to suit an adapter would put the vault's rule second, so this file maps the one
 * to the other instead.
 */

import type { Clock, ModelError, ModelSlot, Result, SecretsSlot } from "@autumnsgrove/lyra";
import { openRouter, type FetchLike } from "@autumnsgrove/lyra/openai";

import { scriptedSlot, type ScriptTurn } from "./script.js";

import type { Env } from "./session.js";

/** The name every placeholder reply reports, so the record shows which model answered. */
export const PLACEHOLDER_MODEL_NAME = "playground-placeholder";

/**
 * The model that decides nothing (slice 1's shell).
 *
 * It calls `finish` on its first turn, which ends the run at once and needs no key and no
 * network, so the gate and a local run work without a secret. It reports zero tokens and
 * no cost rather than inventing a number: slice 7's day cap treats a reply with no cost
 * as an unpriced day, and a placeholder that claimed a price would hide that it never
 * called a model.
 */
export const PLACEHOLDER_MODEL: ModelSlot = {
	async complete(request) {
		// Every segment calls `finish`, including a follow-up's. A segment is its own run
		// of the loop (decision 44), so a finished one does not forbid the next its finish;
		// answering with text instead was a live bug, because a segment that never finishes
		// is what the stuck safeguard parks (found in review on #81).
		void request;
		return {
			ok: true,
			value: {
				text: "",
				toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }],
				usage: { inputTokens: 0, outputTokens: 0 },
				finishReason: "tool_calls",
				model: PLACEHOLDER_MODEL_NAME,
			},
		};
	},
};

/**
 * What a run asks when the deployment sets no list: one model, which is the one Autumn
 * said to try first. A picker over a free-text id would turn a typo into a failed run
 * and a surprise bill, which is the plan's own reason for an allow-list.
 */
export const DEFAULT_MODELS: readonly string[] = ["deepseek/deepseek-v4.1-flash-1017"];

/** The sources this Worker can build. `lumen` arrives with slice 8's demonstration. */
export const MODEL_SOURCES = ["openrouter", "placeholder"] as const;

/**
 * The allow-list as a deployment set it, in its own order.
 *
 * Unset, blank or nothing but separators is the default list rather than an empty picker:
 * a deployment that cannot name a model still needs one to run.
 */
export function modelsFrom(env: Pick<Env, "PLAYGROUND_MODELS">): readonly string[] {
	const raw = env.PLAYGROUND_MODELS;
	if (typeof raw !== "string") {
		return DEFAULT_MODELS;
	}
	const models = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	return models.length === 0 ? DEFAULT_MODELS : models;
}

/** A source name as the bindings give it: trimmed and case-folded, `openrouter` unset. */
function sourceName(env: Env): string {
	return (env.MODEL_SOURCE ?? "openrouter").trim().toLowerCase();
}

/**
 * The key by the name the adapter asks for, from the binding this Worker actually has.
 *
 * A value that is not a non-empty string is nothing held, which is what the adapter reads
 * as a missing secret: it then fails `permission_denied` before any request is made, so a
 * deployment without a key is a run that says so rather than a run that retries.
 */
function secretsFrom(env: Env): SecretsSlot {
	return {
		async get(name) {
			if (name !== "OPENROUTER_API_KEY") {
				return undefined;
			}
			const value = env.LYRA_PLAYGROUND_OPENROUTER_API_KEY;
			return typeof value === "string" && value !== "" ? value : undefined;
		},
	};
}

/** What a test needs to drive the slot without a socket or a real clock. */
export interface ModelDeps {
	clock: Clock;
	fetch?: FetchLike;
	/** The turns a scripted smoke run asks, when this session holds one (PGS41). */
	script?: () => readonly ScriptTurn[] | undefined;
	/** The tenant this session belongs to, which decides whether a model may be asked at all. */
	tenant?: string | undefined;
}

/** A source nobody can build, refused by name when a run asks rather than at boot. */
function unknownSource(name: string): ModelSlot {
	return {
		async complete(): Promise<Result<never, ModelError>> {
			return {
				ok: false,
				error: {
					code: "bad_request",
					message: `MODEL_SOURCE "${name}" is not one this Worker knows (${MODEL_SOURCES.join(", ")})`,
					retryable: false,
				},
			};
		},
	};
}

/**
 * The slot the session hands its run.
 *
 * The source is read per object rather than captured at deploy, so changing a binding is
 * a redeploy and not a rewrite. An unknown source is a slot that refuses: a typo must
 * never fall through to a provider, because the thing that would fall through is a bill.
 */
/** The slot a smoke tenant gets when it has no script: it refuses rather than spends. */
function unrunnableSmokeSession(): ModelSlot {
	return {
		async complete(): Promise<Result<never, ModelError>> {
			return {
				ok: false,
				error: {
					code: "permission_denied",
					message:
						"the smoke tenant only runs a script, and this run has none: a scripted start carries x-lyra-script and x-lyra-script-token",
					retryable: false,
				},
			};
		},
	};
}

/**
 * A slot that re-checks the session's tenant on **every call**, not at build time.
 *
 * The tenant is learned from a request's bearer, and an object can be built by a request
 * that carried none — an unauthenticated direct hit, which the door refuses but which still
 * built and cached the session. That cached model would then answer a later smoke-tenant
 * follow-up on the real provider, which is the spend path the guard exists to close. Asking
 * on each call is what makes the guarantee independent of which request arrived first
 * (review on #101).
 */
export function smokeGuardedModel(options: {
	tenant: () => string | undefined;
	smokeTenant: string | undefined;
	script: () => ModelSlot | undefined;
	inner: ModelSlot;
}): ModelSlot {
	return {
		async complete(request) {
			const tenant = options.tenant();
			if (tenant !== undefined && tenant === options.smokeTenant) {
				return (options.script() ?? unrunnableSmokeSession()).complete(request);
			}
			return options.inner.complete(request);
		},
	};
}

export function modelFor(env: Env, deps: ModelDeps): ModelSlot {
	// A script wins over the configured source: the header was accepted only from the smoke
	// tenant, and a smoke run must spend nothing on a provider.
	const script = deps.script?.();
	if (script !== undefined) {
		return scriptedSlot(script);
	}
	// The smoke tenant's token exists to run scripts, so it can never reach a provider —
	// headerless or after an eviction dropped the script. A smoke job that finds this has a
	// bug, and it should cost nothing rather than spend the person's key (review on #101).
	if (deps.tenant !== undefined && deps.tenant === env.LYRA_PLAYGROUND_SMOKE_TENANT) {
		return unrunnableSmokeSession();
	}
	const name = sourceName(env);
	const model = modelsFrom(env)[0] ?? DEFAULT_MODELS[0] ?? "";

	switch (name) {
		case "placeholder":
			return PLACEHOLDER_MODEL;
		case "openrouter":
			return openRouter({
				model,
				secrets: secretsFrom(env),
				clock: deps.clock,
				...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
			});
		default:
			return unknownSource(name);
	}
}
