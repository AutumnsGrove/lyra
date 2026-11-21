/**
 * A small Lyra host on Cloudflare, serving the protocol (step 6).
 *
 * One Durable Object holds one session: its record in SQLite, its wake as the
 * object's alarm, and the protocol over HTTP. The model answers from a fixed script
 * so the example needs no key and no network: it reads a file, writes one, and
 * finishes. It is an example and a build check, not a product.
 *
 * `pnpm dev` runs it under `wrangler dev`, and `pnpm lyra start <task>` drives it.
 * The token comes from `LYRA_TOKEN` and the tenant from `LYRA_TENANT`, so a local
 * run needs no secret; a real host reads both from secret bindings.
 */

import {
	createFinishTool,
	ok,
	systemClock,
	systemIds,
	type ModelSlot,
	type Recipe,
	type Tool,
} from "@autumnsgrove/lyra";
import {
	createCloudflareSession,
	createSessionWorker,
	type DurableObjectNamespaceLike,
} from "@autumnsgrove/lyra/cloudflare";

interface Env {
	SESSION: DurableObjectNamespace;
	LYRA_TOKEN: string;
	LYRA_TENANT: string;
}

/** A tool that answers at once, which is all the example's two tools need to do. */
function answering(name: string, content: string): Tool {
	return {
		spec: { name, description: name, parameters: { type: "object", properties: {} } },
		execute: async () => ({ isError: false, content }),
	};
}

/** The two-tool task the example runs: read the note, write it back, finish. */
const recipe: Recipe = {
	name: "workers-minimal",
	version: 1,
	instructions: "Read the note, write it back, then finish.",
	tools: [
		answering("read", "the note says hello"),
		answering("write", "written"),
		createFinishTool({ check: () => ({ ok: true }) }),
	],
};

/** A model with nothing to decide, so the example runs with no key and no network. */
const exampleModel: ModelSlot = {
	async complete(request) {
		const turns = request.messages.filter((message) => message.role === "assistant").length;
		const name = turns === 0 ? "read" : turns === 1 ? "write" : "finish";
		const args = name === "finish" ? "{}" : '{"path":"note.md"}';
		return ok({
			text: "",
			toolCalls: [{ id: `c${turns + 1}`, name, arguments: args }],
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "tool_calls",
			model: "example-model",
		});
	},
};

export class Session implements DurableObject {
	#session: ReturnType<typeof createCloudflareSession> | undefined;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {}

	#build(): ReturnType<typeof createCloudflareSession> {
		this.#session ??= createCloudflareSession(this.ctx, {
			recipes: new Map([[recipe.name, recipe]]),
			model: exampleModel,
			clock: systemClock(),
			ids: systemIds(),
			tokens: { [this.env.LYRA_TENANT]: this.env.LYRA_TOKEN },
			host: "examples/workers-minimal",
		});
		return this.#session;
	}

	async fetch(request: Request): Promise<Response> {
		return this.#build().fetch(request);
	}

	async alarm(): Promise<void> {
		await this.#build().alarm();
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const route = createSessionWorker({
			namespace: env.SESSION as unknown as DurableObjectNamespaceLike,
			tokens: { [env.LYRA_TENANT]: env.LYRA_TOKEN },
		});
		return route(request);
	},
} satisfies ExportedHandler<Env>;
