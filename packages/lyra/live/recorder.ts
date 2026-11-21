/**
 * Writing a cassette, which is the only part of recording that needs a disk.
 *
 * The recording itself is the testkit's `recordingFetch`, which scrubs as it
 * goes; this writes the file, and refuses to write one that still holds a key.
 * `node:fs` is allowed here because `live/` is outside the package and never
 * published (`AGENTS.md`, "Hard rules").
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { encodeCassette, scanForSecrets, type Cassette } from "../src/testkit/cassette.ts";
import { keyValues } from "./env.ts";

/** Where a cassette lands, relative to the repository root. */
export function cassettePath(name: string): string {
	return new URL(`../../../cassettes/${name}.json`, import.meta.url).pathname;
}

export async function writeCassette(cassette: Cassette, path: string): Promise<void> {
	const text = encodeCassette(cassette);
	const hits = scanForSecrets(text, { keys: keyValues() });
	if (hits.length > 0) {
		throw new Error(
			`refusing to write a cassette holding ${hits.map((hit) => hit.what).join(", ")}: scrub the exchange first`,
		);
	}
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, text, "utf8");
}
