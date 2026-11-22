/**
 * SHA-256 over text, as hex (docs/run-record.md, decision 91).
 *
 * A run's pin hashes its instructions and its tools, and a compaction records the
 * hash of the instructions its summary was written from. Both want the same one
 * function, and `crypto.subtle` is web-standard, so this works on Workers and on
 * Node without a dependency.
 */

const encoder = new TextEncoder();

export async function hashText(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
