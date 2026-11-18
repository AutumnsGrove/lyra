/**
 * Short names for things that have to be exact (docs/recipes-and-tools.md, HND01 to
 * HND06; decision 114).
 *
 * A model should never copy a commit hash or a link: Lumen's scrubber may rewrite a
 * long string on the way to the model (decision 8), and a copied hash is a typo
 * waiting to happen. So a tool mints a handle such as `c1` or `pr12`, keeps the map
 * back to the real value, and the model cites the handle. The table lives inside a
 * recipe's state, so replaying the saved results rebuilds it exactly (decision 32).
 *
 * It is a `Map`, never a plain object, because a handle is a model's input: a key
 * of `__proto__` or `constructor` must be an ordinary miss, not a prototype.
 *
 * Minting is deterministic: the same kind and canonical target always give the same
 * handle, counters start at one per kind, and minting in the same order rebuilds the
 * same table. That is what makes a resumed run's handles equal to a live run's.
 */

import { isJsonValue, type JsonValue } from "./json.js";
import { canonicalJson } from "./recipe.js";

/** The most names one error message lists before it says how many are left. */
const DEFAULT_LIST_CAP = 10;

/** A handle's shape, as a rule a tool author can rely on. */
const KIND = /^[a-z]{1,8}$/;

export interface HandleTable {
	/** Name a target, or return the name it already has (HND02). */
	mint(kind: string, target: JsonValue): string;
	/** The real value behind a handle, or `undefined` for one this table never made. */
	resolve(handle: string): JsonValue | undefined;
	has(handle: string): boolean;
	/** Every handle of a kind, or every handle, in the order it was minted. */
	list(kind?: string): string[];
	/** A short line naming what a model could have used, capped (HND04). */
	describe(kind?: string, cap?: number): string;
	size(): number;
}

export function createHandleTable(): HandleTable {
	const byHandle = new Map<string, JsonValue>();
	const byTarget = new Map<string, string>();
	const counters = new Map<string, number>();
	const minted: string[] = [];
	const byKind = new Map<string, string[]>();

	return {
		mint(kind, target) {
			if (!KIND.test(kind)) {
				// A kind is the tool author's own word, never the model's, so this is a
				// programming error rather than a refusal the model reads.
				throw new Error(
					`a handle kind must be one to eight lowercase letters, not "${kind}"`,
				);
			}
			if (!isJsonValue(target)) {
				throw new Error("a handle's target must be JSON, so replay can rebuild it");
			}
			const key = `${kind}\u0000${canonicalJson(target)}`;
			const known = byTarget.get(key);
			if (known !== undefined) {
				return known;
			}
			const next = (counters.get(kind) ?? 0) + 1;
			counters.set(kind, next);
			const handle = `${kind}${next}`;
			byHandle.set(handle, target);
			byTarget.set(key, handle);
			minted.push(handle);
			const ofKind = byKind.get(kind);
			if (ofKind === undefined) {
				byKind.set(kind, [handle]);
			} else {
				ofKind.push(handle);
			}
			return handle;
		},

		resolve: (handle) => byHandle.get(handle),
		has: (handle) => byHandle.has(handle),
		list: (kind) => [...(kind === undefined ? minted : (byKind.get(kind) ?? []))],

		describe(kind, cap = DEFAULT_LIST_CAP) {
			const names = kind === undefined ? minted : (byKind.get(kind) ?? []);
			if (names.length === 0) {
				return kind === undefined ? "no handles are known" : `no ${kind} handles are known`;
			}
			const shown = names.slice(0, cap).join(", ");
			const left = names.length - cap;
			const what = kind === undefined ? "the handles" : `the ${kind} handles`;
			return left > 0 ? `${what} are ${shown}, and ${left} more` : `${what} are ${shown}`;
		},

		size: () => byHandle.size,
	};
}

/** The message a tool gives a model that named a handle this table never made. */
export function unknownHandle(table: HandleTable, handle: string, kind?: string): string {
	const shown = handle.length > 40 ? `${handle.slice(0, 40)}...` : handle;
	return `there is no handle "${shown}"; ${table.describe(kind)}`;
}
