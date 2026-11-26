import adapter from "@sveltejs/adapter-static";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The page's build (issue #60, slice 2). Its output is the Worker's assets directory, so
// one deploy serves both the page and the protocol.
//
// SvelteKit 3 takes its configuration here rather than in `svelte.config.js`, which it
// refuses. `fallback` is what makes a deep link work as a single-page app: the Worker's
// assets layer answers anything it does not have with this file, and `run_worker_first`
// keeps `/v1/*` away from it in `wrangler.jsonc`.
export default defineConfig({
	plugins: [
		sveltekit({
			adapter: adapter({
				pages: "../dist/web",
				assets: "../dist/web",
				fallback: "index.html",
				precompress: false,
			}),
		}),
	],
});
