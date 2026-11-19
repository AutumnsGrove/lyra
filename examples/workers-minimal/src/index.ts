/**
 * The smallest useful Lyra host on Cloudflare.
 *
 * One Durable Object holds one run's record, wakes it with its own alarm, and runs
 * the loop against a model that answers immediately, so it needs no key and no
 * network. It is an example and a build check, not a product: a real host swaps the
 * model for an adapter (step 5), reads the recipe from its own code, and serves the
 * record to something.
 */

import {
	createFinishTool,
	createRuntime,
	ok,
	systemClock,
	systemIds,
	type ModelSlot,
	type Recipe,
	type Runtime,
} from "@autumnsgrove/lyra";
import { alarmWaking, durableObjectStorage, scheduledWake } from "@autumnsgrove/lyra/cloudflare";

interface Env {
	MINIMAL_SESSION: DurableObjectNamespace<MinimalSession>;
}

const recipe: Recipe = {
	name: "workers-minimal",
	version: 1,
	instructions: "Say hello and finish.",
	tools: [createFinishTool({ check: () => ({ ok: true }) })],
};

/** A model with nothing to decide, so the example runs with no key and no network. */
const exampleModel: ModelSlot = {
	async complete() {
		return ok({
			text: "hello from Workers",
			toolCalls: [{ id: "c1", name: "finish", arguments: "{}" }],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "tool_calls",
			model: "example-model",
		});
	},
};

export class MinimalSession implements DurableObject {
	constructor(private readonly state: DurableObjectState) {}

	#runtime(): Runtime {
		return createRuntime({
			storage: durableObjectStorage(this.state.storage),
			waking: alarmWaking(this.state.storage),
			clock: systemClock(),
			ids: systemIds(),
			model: exampleModel,
			host: "examples/workers-minimal",
		});
	}

	async fetch(request: Request): Promise<Response> {
		const started = this.#runtime().start({
			runId: crypto.randomUUID(),
			task: recipe.name,
			input: `a run for ${new URL(request.url).pathname}`,
			definition: recipe,
		});
		if (!started.ok) {
			return Response.json({ error: started.error }, { status: 400 });
		}
		const result = await started.value.outcome;
		return Response.json({ reason: result.reason, turns: result.turns });
	}

	async alarm(): Promise<void> {
		try {
			const wake = await scheduledWake(this.state.storage);
			if (wake === undefined) {
				return;
			}
			await this.#runtime().wake({
				runId: wake.runId,
				task: recipe.name,
				definition: recipe,
			});
		} catch {
			// An alarm is retried when its handler throws, so a domain failure is not a
			// reason to ask Cloudflare to try again.
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const id = env.MINIMAL_SESSION.idFromName("example");
		return env.MINIMAL_SESSION.get(id).fetch(request);
	},
} satisfies ExportedHandler<Env>;
