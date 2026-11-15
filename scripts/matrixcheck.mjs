#!/usr/bin/env node
/**
 * The matrix rule (docs/engineering-practices.md, decision 62).
 *
 * Every behavior in a spec gets a row in a table, with an ID such as `REC07`.
 * A test's name carries the ID of the row it covers, as a whole component. This
 * script reads the specs and the test names and fails the build when:
 *
 * - a row has no test, or
 * - a test cites an ID that no spec defines.
 *
 * The row tables are written as each area is built. A few areas were specified
 * in full while planning, before any code, so their rows are listed as unbuilt
 * in `scripts/unbuilt-rows.json` with the step that builds them. That list is
 * the only exemption: an ID there must still be a real row, and it must come
 * out in the same change that gives it a test, so the list cannot rot.
 */
import { readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = join(ROOT, "docs");
const PACKAGE_DIR = join(ROOT, "packages");
const ID = /^[A-Z]{2,6}\d{1,3}$/;

const unbuilt = JSON.parse(await readFile(join(ROOT, "scripts/unbuilt-rows.json"), "utf8"));

/** Row IDs this document has marked as not built yet. */
function unbuiltRows(doc) {
	return new Set(unbuilt[doc]?.rows ?? []);
}

async function walk(dir, filter) {
	const entries = await readdir(dir, { withFileTypes: true });
	const files = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			files.push(...(await walk(path, filter)));
		} else if (filter(entry.name)) {
			files.push(path);
		}
	}
	return files;
}

/** Rows are table rows whose first cell is nothing but an ID. */
async function specRows() {
	const rows = new Map();
	const docs = await walk(DOCS_DIR, (name) => name.endsWith(".md"));
	for (const doc of docs) {
		const lines = (await readFile(doc, "utf8")).split("\n");
		for (const [index, line] of lines.entries()) {
			const firstCell = line.split("|")[1];
			if (firstCell === undefined) {
				continue;
			}
			const id = firstCell.replace(/[*`\s]/g, "");
			if (ID.test(id)) {
				rows.set(id, `${relative(ROOT, doc)}:${index + 1}`);
			}
		}
	}
	return rows;
}

/** Test titles cite rows; anything outside a title is a comment, not a claim. */
async function testCitations() {
	const citations = new Map();
	const pattern = /\b(?:test|it|describe)(?:\.\w+)?\s*\(\s*(["'`])(.*?)\1/gs;
	const tests = await walk(PACKAGE_DIR, (name) => name.endsWith(".test.ts"));
	for (const file of tests) {
		const source = await readFile(file, "utf8");
		for (const match of source.matchAll(pattern)) {
			const title = match[2];
			for (const token of title.matchAll(
				/(?:^|[^A-Za-z0-9])([A-Z]{2,6}\d{1,3})(?![A-Za-z0-9])/g,
			)) {
				const id = token[1];
				if (!citations.has(id)) {
					citations.set(id, []);
				}
				citations.get(id).push(`${relative(ROOT, file)}: ${title}`);
			}
		}
	}
	return citations;
}

const rows = await specRows();
const citations = await testCitations();
const problems = [];
let unbuiltCount = 0;

for (const [id, where] of rows) {
	const doc = where.slice(0, where.lastIndexOf(":"));
	const pending = unbuiltRows(doc).has(id);
	if (pending && citations.has(id)) {
		problems.push(`row ${id} (${where}) is listed as unbuilt but has a test; remove it`);
	} else if (!pending && !citations.has(id)) {
		problems.push(`row ${id} (${where}) has no test`);
	}
	if (pending) {
		unbuiltCount += 1;
	}
}

for (const [doc, entry] of Object.entries(unbuilt)) {
	if (doc.startsWith("_")) {
		continue;
	}
	for (const id of entry.rows) {
		if (!rows.has(id)) {
			problems.push(
				`scripts/unbuilt-rows.json lists ${id} under ${doc}, which has no such row`,
			);
		}
		const where = rows.get(id);
		if (where !== undefined && !where.startsWith(`${doc}:`)) {
			problems.push(`${id} is listed as unbuilt under ${doc} but its row is in ${where}`);
		}
	}
}

for (const [id, tests] of citations) {
	if (!rows.has(id)) {
		for (const test of tests) {
			problems.push(`test cites ${id}, which no spec defines: ${test}`);
		}
	}
}

if (problems.length > 0) {
	console.error(`matrixcheck: ${problems.length} problem(s)\n`);
	for (const problem of problems) {
		console.error(`  ${problem}`);
	}
	process.exit(1);
}

console.log(
	`matrixcheck: ok (${rows.size} spec row(s): ${rows.size - unbuiltCount} tested, ${unbuiltCount} unbuilt)`,
);
