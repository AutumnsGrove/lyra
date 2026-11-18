/**
 * The recipe's pin (docs/run-record.md, decision 91; REC05 to REC09).
 *
 * A run can outlive a deploy, and deploys evict a Durable Object once or twice a
 * day, so a resume often runs on code that is newer than the run. The header pins
 * what the run started with, and a resume compares the current definition to it:
 * the same tools and instructions continue, a reworded prompt or a new version is
 * noted, and a changed tool set stops for a person, because a tool the record
 * already used may no longer exist.
 *
 * The hashes are SHA-256 over canonical JSON (keys sorted at every level) of the
 * tool names and their argument schemas, and of the instructions' text. Descriptions
 * are left out on purpose: rewording a description does not change what a tool
 * does, so it must not stop a run. `crypto.subtle` is web-standard, so this works on
 * Workers and on Node, and being async is the price of not growing a dependency.
 */

import type { RecipeStamp, ToolStamp } from "../record/entries.js";
import type { ToolSpec } from "./model.js";

const encoder = new TextEncoder();

/** JSON with object keys sorted at every level, so the same value always hashes the same. */
export function canonicalJson(value: unknown): string {
	if (value === undefined) {
		return "null";
	}
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	const object = value as Record<string, unknown>;
	const keys = Object.keys(object).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
		.join(",")}}`;
}

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** One tool's pin: its name and the hash of its name and arguments, never its description. */
export async function stampTool(spec: ToolSpec): Promise<ToolStamp> {
	const hash = await sha256Hex(canonicalJson({ name: spec.name, parameters: spec.parameters }));
	return { name: spec.name, hash };
}

export interface RecipeDefinition {
	name: string;
	version: number;
	/** The instructions the model is given, which is the run's `system` text. */
	instructions: string;
	tools: readonly ToolSpec[];
}

export async function pinRecipe(definition: RecipeDefinition): Promise<RecipeStamp> {
	const stamps: ToolStamp[] = [];
	for (const spec of definition.tools) {
		stamps.push(await stampTool(spec));
	}
	stamps.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
	return {
		name: definition.name,
		version: definition.version,
		toolSetHash: await sha256Hex(canonicalJson(stamps)),
		instructionsHash: await sha256Hex(definition.instructions),
		tools: stamps,
	};
}

export interface RecipeChange {
	added: string[];
	removed: string[];
	changed: string[];
}

/** What changed between two pins' tool sets, by name. */
export function compareTools(
	before: readonly ToolStamp[] | undefined,
	after: readonly ToolStamp[] | undefined,
): RecipeChange {
	const old = new Map((before ?? []).map((tool) => [tool.name, tool.hash]));
	const now = new Map((after ?? []).map((tool) => [tool.name, tool.hash]));
	const added: string[] = [];
	const removed: string[] = [];
	const changed: string[] = [];

	for (const [name, hash] of now) {
		const previous = old.get(name);
		if (previous === undefined) {
			added.push(name);
		} else if (previous !== hash) {
			changed.push(name);
		}
	}
	for (const name of old.keys()) {
		if (!now.has(name)) {
			removed.push(name);
		}
	}
	return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/**
 * One line naming what moved, for a parked status's `detail`, or for the
 * `recipe_updated` entry that says a run carried on. A tool the record already used
 * and no longer has is flagged, because that is the case the pin exists to catch:
 * the model may ask for it and nothing would answer.
 */
export function describeChange(change: RecipeChange, used: ReadonlySet<string>): string {
	const parts: string[] = [];
	if (change.added.length > 0) {
		parts.push(`added ${change.added.join(", ")}`);
	}
	if (change.removed.length > 0) {
		parts.push(
			`removed ${change.removed
				.map((name) => (used.has(name) ? `${name} (was used)` : name))
				.join(", ")}`,
		);
	}
	if (change.changed.length > 0) {
		parts.push(`changed ${change.changed.join(", ")}`);
	}
	return parts.length === 0 ? "the instructions changed" : parts.join("; ");
}
