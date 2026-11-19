/**
 * The Worker under test (docs/implementation/04-cloudflare-adapter.md).
 *
 * It exists so the plugin has a module to boot and a Durable Object class to
 * migrate. It is test support, so it is named `.testing.ts`: the library build,
 * the budget and the coverage floor all leave it out, and it may import the
 * testkit even though nothing in the adapter's production code may.
 */

export { FixtureSession } from "./fixture-session.testing.js";

export default {
	async fetch(): Promise<Response> {
		return new Response("lyra cloudflare fixture");
	},
};
