import { readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vitest";

import { ROOT } from "./workflows.ts";

/**
 * The row is in `docs/playground.md`: PGS03. It lives here rather than in the package
 * because it reads a file from disk, which is what `scripts/` is for.
 *
 * The routing that keeps `/v1/*` away from the page lives in configuration, not in
 * code, so no unit test would notice it going missing. With static assets and a
 * single-page fallback, a request that matches no asset is answered with
 * `index.html`, so without `run_worker_first` every protocol call would receive the
 * page — and the gate would stay green, because nothing else reads this file.
 */

/**
 * JSONC as data: comments stripped, trailing commas allowed.
 *
 * A tiny parser rather than a dependency, because the file is wrangler's config and its
 * two JSONC features are all the playground uses. It tracks strings properly, escapes
 * included, so a `//` inside a value — a URL, say — survives: a stripper that looked
 * only at the character before a quote would flip its state on a value ending in a
 * backslash and cut the rest of the line (found in review).
 */
export function parse(source: string): Record<string, unknown> {
	let out = "";
	let inString = false;
	for (let index = 0; index < source.length; index += 1) {
		const char = source[index];
		if (inString && char === "\\") {
			// The escaped character cannot end the string, whatever it is.
			out += char;
			index += 1;
			out += source[index] ?? "";
			continue;
		}
		if (!inString && char === "/" && source[index + 1] === "/") {
			while (index < source.length && source[index] !== "\n") {
				index += 1;
			}
			out += "\n";
			continue;
		}
		if (char === '"') {
			inString = !inString;
		}
		out += char;
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1")) as Record<string, unknown>;
}

/** The config as data, read where it is deployed from. */
function config(): Record<string, unknown> {
	return parse(readFileSync(join(ROOT, "packages/playground/wrangler.jsonc"), "utf8"));
}

test("PGS03 the protocol path is claimed by the Worker before the page can answer it", () => {
	const wrangler = config();
	const assets = wrangler["assets"] as
		| { directory?: string; run_worker_first?: string[]; not_found_handling?: string }
		| undefined;

	expect(assets?.directory).toBe("./public");
	// The fallback that makes a deep link work is the same fallback that would answer
	// `/v1/commands` with the page, so the two settings only make sense together.
	expect(assets?.not_found_handling).toBe("single-page-application");
	expect(assets?.run_worker_first).toEqual(["/v1/*"]);
});

test("PGS03 the Worker it deploys is this package's entry point, with one session object", () => {
	const wrangler = config();

	expect(wrangler["name"]).toBe("lyra-playground");
	expect(wrangler["main"]).toBe("src/worker.ts");

	// The binding name the Worker's env reads, the class the export names, and a
	// migration that creates it: a mismatch is a deploy that answers with an error
	// about a class nobody declared.
	const durable = wrangler["durable_objects"] as
		{ bindings?: { name?: string; class_name?: string }[] } | undefined;
	expect(durable?.bindings).toEqual([{ name: "SESSION", class_name: "Session" }]);
	expect(wrangler["migrations"]).toEqual([{ tag: "v1", new_sqlite_classes: ["Session"] }]);

	// The tenant is configuration; the token is a secret, so it must not be here.
	const vars = wrangler["vars"] as Record<string, string> | undefined;
	expect(vars?.["PLAYGROUND_TENANT"]).toBe("playground");
	expect(Object.keys(vars ?? {})).not.toContain("PLAYGROUND_TOKEN");
});

test("PGS03 the parser keeps a // inside a value, and a value that ends in a backslash", () => {
	// Neither shape is in the config today. They are here because the parser is the one
	// piece of this test that could quietly change what it reads: a URL added to `vars`
	// must not be truncated, and an escaped backslash must not look like a closing quote.
	const parsed = parse(
		[
			"{",
			'  // a comment with \"quotes\" in it',
			'  "url": "https://example.test//path",',
			'  "escaped": "a\\\\",',
			"  // a comment after a value ending in a backslash",
			'  "after": "still here"',
			"}",
		].join("\n"),
	);
	expect(parsed).toEqual({
		url: "https://example.test//path",
		// JSON's `"a\\"` is one backslash; the point is that the quote after it closes
		// the string rather than being read as escaped.
		escaped: "a\\",
		after: "still here",
	});
});
