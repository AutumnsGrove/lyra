import { expect, test } from "vitest";

import { createHandleTable, unknownHandle } from "./handles.js";
import type { JsonValue } from "./json.js";

/** The rows are in `docs/recipes-and-tools.md`, HND01 to HND06. */

test("HND01 mint and resolve, per kind, from one", () => {
	const table = createHandleTable();
	expect(table.mint("c", "abc123")).toBe("c1");
	expect(table.mint("c", "def456")).toBe("c2");
	expect(table.resolve("c1")).toBe("abc123");
	expect(table.resolve("c2")).toBe("def456");
	expect(table.list("c")).toEqual(["c1", "c2"]);
	expect(table.size()).toBe(2);
});

test("HND02 minting the same target again returns the handle it already has", () => {
	const table = createHandleTable();
	const first = table.mint("pr", { number: 12, repo: "lyra" });
	const again = table.mint("pr", { repo: "lyra", number: 12 });
	expect(again).toBe(first);
	expect(table.size()).toBe(1);
	// A different target in the same kind is a new name.
	expect(table.mint("pr", { number: 13, repo: "lyra" })).toBe("pr2");
});

test("HND03 each kind counts from its own one", () => {
	const table = createHandleTable();
	expect(table.mint("c", "a")).toBe("c1");
	expect(table.mint("pr", "b")).toBe("pr1");
	expect(table.mint("i", "c")).toBe("i1");
	expect(table.mint("c", "d")).toBe("c2");
});

test("HND04 an unknown handle names what the model could have used, capped", () => {
	const table = createHandleTable();
	for (let index = 1; index <= 15; index += 1) {
		table.mint("c", `commit${index}`);
	}
	expect(table.resolve("c99")).toBeUndefined();
	const message = unknownHandle(table, "c99", "c");
	expect(message).toContain("c99");
	expect(message).toContain("c1");
	expect(message).toContain("and 5 more");
	expect(message.length).toBeLessThan(300);

	const empty = unknownHandle(createHandleTable(), "x1");
	expect(empty).toContain("no handles are known");
});

test("HND05 the same mint order rebuilds the same table", () => {
	const target = (index: number) => ({ repo: "lyra", sha: `sha${index}` });
	const live = createHandleTable();
	for (let index = 1; index <= 5; index += 1) {
		live.mint("c", target(index));
	}

	const replayed = createHandleTable();
	for (let index = 1; index <= 5; index += 1) {
		replayed.mint("c", target(index));
	}

	expect(replayed.list()).toEqual(live.list());
	for (const handle of live.list()) {
		expect(replayed.resolve(handle)).toEqual(live.resolve(handle));
	}
});

test("HND06 a hostile handle is simply unknown, and nothing pollutes a prototype", () => {
	const table = createHandleTable();
	for (const handle of ["c1; drop", "x".repeat(10_000), "__proto__", "constructor"]) {
		expect(table.resolve(handle)).toBeUndefined();
		expect(table.has(handle)).toBe(false);
	}
	const withProto = JSON.parse('{"__proto__": {"polluted": true}}') as JsonValue;
	expect(table.mint("c", withProto)).toBe("c1");
	expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
	expect(table.resolve("__proto__")).toBeUndefined();
});
