/**
 * The real session object, wrapped for the workers suite (step 6, slice 5).
 *
 * The wrapper exists for two reasons, both of them the test's: it holds the fake
 * clock so a test can advance a run that is waiting on it after an eviction, and it
 * lets the test Worker choose the scripts. Everything it answers comes from
 * `createCloudflareSession`, which is the code a host ships.
 */

import { DurableObject } from "cloudflare:workers";

import type { JsonValue } from "../../../core/json.js";
import type { ModelSlot, ModelRequest } from "../../../core/model.js";
import { ok } from "../../../core/result.js";
import type { RunDefinition } from "../../../core/runtime.js";
import { counterIds } from "../../memory/index.js";
import {
	createFinishTool,
	fakeClock,
	toolReturning,
	toolTakingTime,
	type FakeClock,
} from "../../../testkit/index.js";
import { durableObjectStorage } from "../storage.js";
import { createCloudflareSession, type CloudflareSession } from "../session.js";

export const TOKENS = { acme: "tok-acme", other: "tok-other" };

/**
 * The task the workers suite runs: the input is the script. Each turn is a list of
 * calls, and the model acts them out one turn at a time, so one recipe can serve
 * every scenario without a global the object cannot see.
 */
interface Script {
	turns: { text?: string; calls: { name: string; args?: JsonValue }[] }[];
}

function scriptOf(request: ModelRequest): Script | undefined {
	for (const message of request.messages) {
		if (message.role !== "user") {
			continue;
		}
		try {
			const parsed: unknown = JSON.parse(message.text);
			if (
				typeof parsed === "object" &&
				parsed !== null &&
				Array.isArray((parsed as Script).turns)
			) {
				return parsed as Script;
			}
		} catch {
			// A message that is not a script is not this model's business.
		}
	}
	return undefined;
}

/** The turn the model should be on, counted the way the record counts them. */
function scriptedByInput(): ModelSlot {
	return {
		async complete(request) {
			const script = scriptOf(request);
			if (script === undefined) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: "the test model found no script in the conversation",
						retryable: false,
					},
				};
			}
			const turn = request.messages.filter((message) => message.role === "assistant").length;
			const next = script.turns[turn];
			if (next === undefined) {
				return {
					ok: false,
					error: {
						code: "internal",
						message: `the test model has no turn ${turn + 1}`,
						retryable: false,
					},
				};
			}
			return ok({
				text: next.text ?? "",
				toolCalls: next.calls.map((call, index) => ({
					id: `c${turn + 1}-${index + 1}`,
					name: call.name,
					arguments: JSON.stringify(call.args ?? {}),
				})),
				usage: { inputTokens: 1, outputTokens: 1 },
				finishReason: next.calls.length === 0 ? "stop" : "tool_calls",
				model: "test-model",
			});
		},
	};
}

/** The recipe the workers suite starts: its input is the script, and the script is the first message. */
function recipeFor(clock: FakeClock): RunDefinition {
	return {
		name: "test-task",
		version: 1,
		instructions: "act out the script",
		setup: (input: JsonValue) => ({ message: JSON.stringify(input), state: undefined }),
		tools: [
			toolReturning("read", "the file"),
			toolReturning("write", "written"),
			toolTakingTime("slow", 5_000, clock),
			createFinishTool(),
		],
	};
}

export class TestSession extends DurableObject<Cloudflare.Env> {
	#clock: FakeClock | undefined;
	#session: CloudflareSession | undefined;
	#requests = 0;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
	}

	#build(): CloudflareSession {
		if (this.#session !== undefined) {
			return this.#session;
		}
		const clock = fakeClock();
		this.#clock = clock;
		const scripted = scriptedByInput();
		this.#session = createCloudflareSession(this.ctx, {
			recipes: new Map([["test-task", recipeFor(clock)]]),
			// Counted here, so a test can wait for the run to reach the model without
			// reaching into the loop's own bookkeeping.
			model: {
				complete: async (request: ModelRequest) => {
					this.#requests += 1;
					return scripted.complete(request);
				},
			},
			clock,
			ids: counterIds(),
			tokens: TOKENS,
			host: "workers-test",
		});
		return this.#session;
	}

	advance(ms: number): void {
		this.#clock?.advance(ms);
	}

	requests(): number {
		return this.#requests;
	}

	/** The record, read through the same storage adapter the session writes. */
	async lines(): Promise<string[]> {
		const read = await durableObjectStorage(this.ctx.storage).read();
		return read.ok ? read.value : [];
	}

	override async fetch(request: Request): Promise<Response> {
		return this.#build().fetch(request);
	}

	override async alarm(): Promise<void> {
		await this.#build().alarm();
	}

	/** The trusted door a service binding's entry point calls. */
	async send(request: { tenant: string; frame: string }): Promise<string> {
		return this.#build().send(request);
	}
}
