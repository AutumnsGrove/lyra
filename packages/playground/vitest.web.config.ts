import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vitest/config";

// The page's own tests (issue #60, slice 2), separate from the workspace's Node suite
// because they need two things the core's tests must not have: a compiler for `.svelte`
// files, and a DOM to render them into.
//
// The DOM is `happy-dom`, not a browser: it is a Node object model with no layout and no
// window manager, so "no browser" in `AGENTS.md` still holds — nothing here can pass
// because a real renderer did something. What it buys is that the component a person
// actually loads is the thing under test, rather than a copy of its logic.
export default defineConfig({
	// No options: `hot` was removed in vite-plugin-svelte 7, and passing it now only warns.
	plugins: [svelte()],
	resolve: {
		// A Svelte 5 component compiled by the plugin expects the browser condition, and
		// this config runs on Node.
		conditions: ["browser"],
	},
	test: {
		include: ["web/src/**/*.test.ts"],
		environment: "happy-dom",
		// Svelte 5 tells the runtime which mode it was rendered in; without this a component
		// mounted by a test warns once per render.
		env: { NODE_ENV: "test" },
	},
});
