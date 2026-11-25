/**
 * The playground's front door (issue #60, slice 1).
 *
 * One Worker serves both things: the page, from its static assets, and `/v1/*`, which
 * `run_worker_first` in `wrangler.jsonc` sends here rather than to the assets layer.
 * Everything protocol-shaped is the Cloudflare adapter's `createSessionWorker`, so this
 * file owns no routing rules of its own — it only supplies the object namespace and the
 * tenant's token.
 */

import {
	createSessionWorker,
	type DurableObjectNamespaceLike,
} from "@autumnsgrove/lyra/cloudflare";

import { tokensFrom, type Env } from "./session.js";

export interface FrontDoor {
	namespace: DurableObjectNamespaceLike;
	tokens: Readonly<Record<string, string>>;
}

/**
 * The door as a function of its two inputs, so a test can drive it with a recording
 * namespace and no bindings. The Worker's `fetch` is this, plus the environment.
 */
export function frontDoor(door: FrontDoor): (request: Request) => Promise<Response> {
	return createSessionWorker({ namespace: door.namespace, tokens: door.tokens });
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		return frontDoor({
			// The declared binding type comes from the runtime's own types, and the
			// adapter asks only for the three methods it calls.
			namespace: env.SESSION as unknown as DurableObjectNamespaceLike,
			tokens: tokensFrom(env),
		})(request);
	},
} satisfies ExportedHandler<Env>;

export { Session } from "./session.js";
