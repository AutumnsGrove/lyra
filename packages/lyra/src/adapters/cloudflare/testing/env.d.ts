/**
 * The bindings this fixture Worker declares, for the workers test program only.
 *
 * `Cloudflare.Env` is the interface `env` is typed as (workers-types), and a
 * project extends it with the bindings its own `wrangler.jsonc` declares. The
 * namespace is left untyped here so this declaration imports nothing: a
 * declaration file is checked by `importcheck` as production, and the fixture it
 * would name is test support.
 */

declare global {
	namespace Cloudflare {
		interface Env {
			FIXTURE_SESSION: DurableObjectNamespace;
			FIXTURE_TOKEN: string;
		}
	}
}

export {};
