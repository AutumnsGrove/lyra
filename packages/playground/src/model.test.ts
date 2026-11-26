import { expect, test } from "vitest";

import { fakeClock } from "@autumnsgrove/lyra/testkit";

import type { Env } from "./session.js";
import {
	DEFAULT_MODELS,
	PLACEHOLDER_MODEL_NAME,
	modelsFrom,
	modelFor,
	smokeGuardedModel,
	type ModelDeps,
} from "./model.js";
import { scriptedSlot } from "./script.js";

/**
 * The rows are in `docs/playground.md`: PGS04 and PGS05.
 *
 * The subject is the seam between a deployment's bindings and the model slot the session
 * gives the run, which is where a typo, a missing key or a reordered list stops being
 * harmless. Nothing here reaches the network: the one test that drives the adapter
 * injects a `fetch` that records the request and answers a two-line stream.
 */

function env(overrides: Partial<Env> = {}): Env {
	return {
		SESSION: {} as DurableObjectNamespace,
		INDEX: {} as DurableObjectNamespace,
		BUDGET: {} as DurableObjectNamespace,
		LYRA_PLAYGROUND_TOKEN: "a-playground-token-for-a-test",
		LYRA_PLAYGROUND_TENANT: "playground",
		...overrides,
	};
}

/** A stream that is one text delta and a finish, which is a whole reply. */
function replyStream(): string {
	return [
		`data: ${JSON.stringify({
			id: "gen-1",
			model: "deepseek/deepseek-v4.1-flash-1017",
			choices: [{ index: 0, delta: { content: "hello" }, finish_reason: "stop" }],
		})}`,
		"",
		"data: [DONE]",
		"",
		// SSE dispatches on the blank line, so the last event needs one too. Without it the
		// reader reports a stream cut mid-event, which is what OAI06 asks for and what this
		// fixture got wrong first.
		"",
	].join("\n");
}

interface Recorded {
	deps: ModelDeps;
	requests: { url: string; headers: Record<string, string>; body: string }[];
}

function recordingDeps(): Recorded {
	const requests: Recorded["requests"] = [];
	return {
		requests,
		deps: {
			clock: fakeClock(),
			fetch: async (url, init) => {
				requests.push({
					url,
					headers: init?.headers ?? {},
					body: init?.body ?? "",
				});
				return new Response(replyStream(), {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			},
		},
	};
}

test("PGS05 the allow-list is the default until a deployment sets one", () => {
	// A picker over a free-text id turns a typo into a failed run and a surprise bill, so
	// the list has a default a deployment cannot accidentally empty.
	expect(modelsFrom(env())).toEqual(DEFAULT_MODELS);
	expect(modelsFrom(env({ PLAYGROUND_MODELS: "" }))).toEqual(DEFAULT_MODELS);
	expect(modelsFrom(env({ PLAYGROUND_MODELS: "   " }))).toEqual(DEFAULT_MODELS);
	// The model Autumn asked to try first is the one a run uses with no picker yet.
	expect(DEFAULT_MODELS[0]).toBe("deepseek/deepseek-v4.1-flash-1017");
});

test("PGS05 a deployment's own list keeps its order and drops blanks", () => {
	expect(modelsFrom(env({ PLAYGROUND_MODELS: " a/b , c/d ,,e/f " }))).toEqual([
		"a/b",
		"c/d",
		"e/f",
	]);
	// One entry is a list of one, not a reason to fall back to the default.
	expect(modelsFrom(env({ PLAYGROUND_MODELS: "only/one" }))).toEqual(["only/one"]);
});

test("PGS04 openrouter is the default source, and it asks the provider for the first allowed model", async () => {
	const { deps, requests } = recordingDeps();
	const slot = modelFor(
		env({
			PLAYGROUND_MODELS: "deepseek/deepseek-v4.1-flash-1017",
			LYRA_PLAYGROUND_OPENROUTER_API_KEY: "a-key-for-a-test",
		}),
		deps,
	);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(true);
	if (!reply.ok) {
		return;
	}
	expect(reply.value.text).toBe("hello");
	expect(requests).toHaveLength(1);
	expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
	// The body names the model a run would ask, not the whole list.
	expect(JSON.parse(requests[0]?.body ?? "{}").model).toBe("deepseek/deepseek-v4.1-flash-1017");
});

test("PGS04 the key reaches the adapter under its own name, from the prefixed binding", async () => {
	// The adapter's preset asks for `OPENROUTER_API_KEY` by that fixed name, and the vault
	// entry is `LYRA_PLAYGROUND_OPENROUTER_API_KEY`. The mapping is the whole reason this
	// file exists, so the assertion is on the header the provider would actually receive.
	const { deps, requests } = recordingDeps();
	const slot = modelFor(
		env({
			MODEL_SOURCE: "openrouter",
			LYRA_PLAYGROUND_OPENROUTER_API_KEY: "a-key-for-a-test",
		}),
		deps,
	);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(true);
	expect(requests[0]?.headers["authorization"]).toBe("Bearer a-key-for-a-test");
});

test("PGS04 a deployment with no key fails before anything is sent", async () => {
	const { deps, requests } = recordingDeps();
	const slot = modelFor(env({ MODEL_SOURCE: "openrouter" }), deps);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(false);
	if (reply.ok) {
		return;
	}
	// Stable and non-retryable, so the loop parks `model_unavailable` instead of retrying
	// a key that will not appear mid-run.
	expect(reply.error.code).toBe("permission_denied");
	expect(reply.error.retryable).toBe(false);
	expect(requests).toHaveLength(0);
});

test("PGS04 placeholder is a source of its own, so the gate and a local run need no key", async () => {
	const { deps, requests } = recordingDeps();
	const slot = modelFor(env({ MODEL_SOURCE: "placeholder" }), deps);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(true);
	if (!reply.ok) {
		return;
	}
	expect(reply.value.model).toBe(PLACEHOLDER_MODEL_NAME);
	expect(requests).toHaveLength(0);
});

test("PGS04 an unknown source is refused by name, rather than quietly calling OpenRouter", async () => {
	// A typo in `MODEL_SOURCE` is a deployment mistake, and the wrong direction is a
	// deployment that spends money on a provider nobody chose. It fails closed, and the
	// detail names the value so the person fixing it can see what they typed.
	const { deps, requests } = recordingDeps();
	const slot = modelFor(
		env({ MODEL_SOURCE: "openruter", LYRA_PLAYGROUND_OPENROUTER_API_KEY: "a-key-for-a-test" }),
		deps,
	);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	expect(reply.ok).toBe(false);
	if (reply.ok) {
		return;
	}
	expect(reply.error.code).toBe("bad_request");
	expect(reply.error.retryable).toBe(false);
	expect(reply.error.message).toContain("openruter");
	expect(requests).toHaveLength(0);
});

test("PGS04 the source name is trimmed and case-folded", async () => {
	const { deps, requests } = recordingDeps();
	const slot = modelFor(
		env({
			MODEL_SOURCE: "  OpenRouter ",
			LYRA_PLAYGROUND_OPENROUTER_API_KEY: "a-key-for-a-test",
		}),
		deps,
	);

	const reply = await slot.complete({
		system: "",
		messages: [{ role: "user", text: "hello" }],
		tools: [],
		signal: new AbortController().signal,
	});

	// It is the OpenRouter source rather than an unknown one, so it really asked.
	expect(reply.ok).toBe(true);
	expect(requests).toHaveLength(1);
});

test("PGS42 a smoke tenant with no script has no model that can spend", async () => {
	// The tenant's token is allowed only to answer a script; if the script is gone (an
	// eviction, a headerless run) the slot refuses rather than reaching a provider.
	const slot = modelFor(
		{
			SESSION: {} as DurableObjectNamespace,
			INDEX: {} as DurableObjectNamespace,
			BUDGET: {} as DurableObjectNamespace,
			LYRA_PLAYGROUND_SMOKE_TENANT: "smoke",
		},
		{ clock: fakeClock(), tenant: "smoke" },
	);
	const reply = await slot.complete({
		system: "s",
		messages: [],
		tools: [],
		signal: new AbortController().signal,
	} as never);
	expect(reply.ok).toBe(false);
	if (!reply.ok) {
		expect(reply.error.retryable).toBe(false);
		expect(reply.error.code).toBe("permission_denied");
	}
});

test("PGS42 a session built before the tenant was known still cannot spend as smoke", async () => {
	// The ordering the review found: an unauthenticated request builds and caches the session
	// with no tenant, and a later smoke follow-up must still hit the guard, which is why the
	// tenant is asked on every call rather than at build time.
	let tenant: string | undefined = undefined;
	let script: ReturnType<typeof scriptedSlot> | undefined = undefined;
	const guarded = smokeGuardedModel({
		tenant: () => tenant,
		smokeTenant: "smoke",
		script: () => script,
		inner: {
			async complete() {
				return {
					ok: false as const,
					error: {
						code: "internal" as const,
						message: "the real model was asked",
						retryable: false,
					},
				};
			},
		},
	});
	const request = {
		system: "s",
		messages: [],
		tools: [],
		signal: new AbortController().signal,
	} as never;

	// First call, before the tenant is known: the inner slot (the refusal above).
	const before = await guarded.complete(request);
	expect(before.ok).toBe(false);
	if (!before.ok) {
		expect(before.error.message).toBe("the real model was asked");
	}

	// Now the tenant is the smoke tenant with no script: the inner slot must not be reached.
	tenant = "smoke";
	const after = await guarded.complete(request);
	expect(after.ok).toBe(false);
	if (!after.ok) {
		expect(after.error.code).toBe("permission_denied");
	}

	// And with a script, it answers the script's turns.
	script = scriptedSlot([{ text: "scripted" }]);
	const withScript = await guarded.complete(request);
	expect(withScript.ok).toBe(true);
	if (withScript.ok) {
		expect(withScript.value.text).toBe("scripted");
	}
});
