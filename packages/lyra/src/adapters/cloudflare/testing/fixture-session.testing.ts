/**
 * The fixture Durable Object (docs/implementation/04-cloudflare-adapter.md).
 *
 * A test double for the step 6 session object, not an exported part of the
 * library. At slice 1 it answers a request and can be reached from a test, which
 * is all the smoke test needs; the storage and waking slices teach it the rest.
 */

export class FixtureSession {
	constructor(readonly state: DurableObjectState) {}

	async fetch(): Promise<Response> {
		const pings = (await this.state.storage.get<number>("pings")) ?? 0;
		await this.state.storage.put("pings", pings + 1);
		return new Response(`fixture session ${pings + 1}`);
	}
}
