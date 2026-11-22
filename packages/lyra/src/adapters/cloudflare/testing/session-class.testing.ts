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
	scriptedModel,
	timelineTestRecipe,
	type FakeClock,
} from "../../../testkit/index.js";
import { makeScenarioTool, type Scenario } from "../../../testkit/scenario.js";
import { toolReturning, toolTakingTime } from "../../../testkit/tools.js";
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
			// A tool that needs a person, so a test can exercise the answer route
			// through the Worker's own front door (REQ02).
			toolReturning("approve", "approved and done", { policy: "ask" }),
			toolTakingTime("slow", 5_000, clock),
			createFinishTool(),
		],
	};
}

export class TestSession extends DurableObject<Cloudflare.Env> {
	#clock: FakeClock | undefined;
	#session: CloudflareSession | undefined;
	#requests = 0;
	/** A scenario file to run, when the workers suite is driving one over HTTP. */
	#scenario: Scenario | undefined;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
	}

	#build(): CloudflareSession {
		if (this.#session !== undefined) {
			return this.#session;
		}
		const clock = fakeClock();
		this.#clock = clock;
		const scenario = this.#scenario;
		const taskName = scenario === undefined ? "test-task" : (scenario.recipe ?? scenario.task);
		const definition: RunDefinition =
			scenario === undefined
				? recipeFor(clock)
				: scenario.recipe === "timeline-test"
					? timelineTestRecipe
					: {
							name: taskName,
							version: 1,
							instructions: scenario.system,
							tools: [
								...scenario.tools.map((tool) => makeScenarioTool(tool, clock)),
								createFinishTool(),
							],
							...(scenario.compaction === undefined
								? {}
								: { compaction: scenario.compaction.settings }),
						};
		const scripted =
			scenario === undefined
				? scriptedByInput()
				: scriptedModel(scenario.model, {
						clock,
						// A scenario that compacts is scripted by request order: the
						// conversation's length stops counting the turns a summary folded away.
						...(scenario.compaction === undefined
							? {}
							: {
									summaries: scenario.compaction.summaries,
									position: "sequence" as const,
								}),
					});
		this.#session = createCloudflareSession(this.ctx, {
			recipes: new Map([[taskName, definition]]),
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

	/**
	 * Run one of the repository's scenario files: its recipe or tools, its script and
	 * its system text. The HTTP runner calls this through `runInDurableObject` before
	 * it starts the run, so every command and event after it is a real one on the wire.
	 */
	configure(scenario: Scenario): void {
		this.#scenario = scenario;
		this.#clock = undefined;
		this.#session = undefined;
		this.#requests = 0;
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
