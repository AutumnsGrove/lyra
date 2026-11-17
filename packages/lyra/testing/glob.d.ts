/**
 * `import.meta.glob` is Vite's, and the scenario test is the only thing here that
 * uses it.
 *
 * It is declared in this folder rather than in `src/` so the library build never
 * sees it: `types: []` and `lib: ["ES2023"]` are how the core stays to the web
 * standard, and a Vite-only global in the published types would be a lie about
 * what a consumer's runtime has. `tsconfig.json` includes this file for the
 * typecheck, which is where tests are checked; `tsconfig.build.json` does not.
 */
interface ImportMeta {
	glob<T = string>(
		pattern: string,
		options: { query?: string; import?: string; eager: true },
	): Record<string, T>;
}
