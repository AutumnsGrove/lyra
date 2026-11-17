/**
 * The web platform surface the core is allowed to use.
 *
 * The library builds with `lib: ["ES2023"]` and `types: []`, so it has no DOM
 * and no Node globals. That is on purpose: the core runs on Cloudflare Workers
 * and on Node from the same code (docs/decisions.md, decisions 12 and 13), and a
 * global that only one of them has would break that promise.
 *
 * So the small set the core needs is declared here, and adding to it is a
 * deliberate act with a reason. A name that is missing fails the typecheck,
 * which is the forcing function: the core cannot quietly reach for `fetch`,
 * `document` or `process` because one of them happened to typecheck.
 *
 * Only the members the core actually uses are declared, not the whole interface.
 */

declare interface AbortSignal {
	readonly aborted: boolean;
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void;
	removeEventListener(type: "abort", listener: () => void): void;
}

declare class AbortController {
	readonly signal: AbortSignal;
	abort(reason?: unknown): void;
}

declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;

declare const crypto: {
	getRandomValues<T extends Uint8Array>(array: T): T;
};

declare class TextEncoder {
	encode(input?: string): Uint8Array;
}

declare class TextDecoder {
	constructor(label?: string);
	decode(input?: Uint8Array): string;
}
