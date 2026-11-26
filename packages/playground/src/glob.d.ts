/**
 * `import.meta.glob` is Vite's, and the scenario runner is the only thing here that uses
 * it. It is declared beside the code rather than pulled in from `vite/client`, because
 * the Worker's program declares its platform by hand and `types: []` is part of that:
 * a Vite global in the deployment's program would be a lie about what it has.
 */
interface ImportMeta {
	glob<T = string>(
		pattern: string,
		options: { query?: string; import?: string; eager: true },
	): Record<string, T>;
}
