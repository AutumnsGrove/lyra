/**
 * A component, as a test imports it.
 *
 * `tsc` does not read `.svelte` files, and the test that renders the page imports one. The
 * declaration is the narrowest thing that typechecks: a Svelte 5 component is a function
 * the compiler produces, and the only place it is used here is `@testing-library/svelte`'s
 * `render`, which takes it as an unknown for its own reasons.
 */
declare module "*.svelte" {
	import type { Component } from "svelte";
	const component: Component<Record<string, never>>;
	export default component;
}
