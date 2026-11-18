import { expect, test } from "vitest";

import type { ToolSpec } from "./model.js";
import { canonicalJson, compareTools, describeChange, pinRecipe, stampTool } from "./recipe.js";

/** The rows are in `docs/run-record.md`, REC05 to REC09. */

function spec(name: string, parameters: ToolSpec["parameters"], description = "a tool"): ToolSpec {
	return { name, description, parameters };
}

const readSpec = spec("read", {
	type: "object",
	properties: { path: { type: "string" }, lines: { type: "number" } },
});

test("REC05 the same definition always pins the same hashes, whatever the key order", async () => {
	const reordered: ToolSpec = {
		name: "read",
		description: "a tool",
		parameters: {
			properties: { lines: { type: "number" }, path: { type: "string" } },
			type: "object",
		},
	};
	const first = await pinRecipe({
		name: "timeline",
		version: 1,
		instructions: "build the page",
		tools: [readSpec],
	});
	const second = await pinRecipe({
		name: "timeline",
		version: 1,
		instructions: "build the page",
		tools: [reordered],
	});

	expect(second.toolSetHash).toBe(first.toolSetHash);
	expect(second.instructionsHash).toBe(first.instructionsHash);
	// A hash is a hex SHA-256, which is what the record's decoder accepts.
	expect(first.toolSetHash).toMatch(/^[0-9a-f]{64}$/);
	expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
});

test("REC05 a tool's description does not change its hash, but its arguments do", async () => {
	const plain = await stampTool(spec("read", { type: "object" }, "the old description"));
	const reworded = await stampTool(spec("read", { type: "object" }, "a much better description"));
	const changed = await stampTool(
		spec("read", { type: "object", properties: { path: { type: "string" } } }),
	);

	expect(reworded.hash).toBe(plain.hash);
	expect(changed.hash).not.toBe(plain.hash);
	expect(plain.name).toBe("read");
});

test("REC07 and REC08 a change is named by tool, and one the run used is flagged", () => {
	const before = [
		{ name: "read", hash: "a" },
		{ name: "write", hash: "b" },
	];
	const after = [
		{ name: "read", hash: "a" },
		{ name: "write", hash: "c" },
		{ name: "delete", hash: "d" },
	];

	const change = compareTools(before, after);
	expect(change).toEqual({ added: ["delete"], removed: [], changed: ["write"] });
	expect(describeChange(change, new Set(["read"]))).toBe("added delete; changed write");

	const removed = compareTools(before, [{ name: "read", hash: "a" }]);
	expect(removed.removed).toEqual(["write"]);
	// A tool the record used is the case worth flagging: the model may still ask for it.
	expect(describeChange(removed, new Set(["write"]))).toBe("removed write (was used)");
	expect(describeChange(removed, new Set(["read"]))).toBe("removed write");

	// Nothing tool-shaped moved, so the instructions are what changed.
	expect(describeChange(compareTools(before, before), new Set())).toBe(
		"the instructions changed",
	);
});
