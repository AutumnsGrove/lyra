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
	/** The recipe pin's hashes, in step 2 (decision 91); web-standard on Workers and Node. */
	subtle: {
		digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer>;
	};
};

declare class TextEncoder {
	encode(input?: string): Uint8Array;
}

declare class TextDecoder {
	constructor(label?: string);
	/** `{ stream: true }` keeps a split multi-byte character for the next call. */
	decode(input?: Uint8Array | ArrayBuffer, options?: { stream?: boolean }): string;
}

/**
 * The model adapters' slice of `fetch`: a request it can make and the response
 * it reads back. `fetch` is web-standard, so nothing here is a dependency; the
 * declarations only keep the library build's `types: []` honest about what a
 * consumer's runtime provides.
 */
interface FetchInit {
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	signal?: AbortSignal;
}

interface FetchHeaders {
	get(name: string): string | null;
	/** Headers iterate as name and value pairs, which is how a recorder copies them. */
	[Symbol.iterator](): IterableIterator<[string, string]>;
}

declare class Headers {
	constructor(init?: Record<string, string>);
	get(name: string): string | null;
}

interface StreamReadResult<R> {
	done: boolean;
	value?: R;
}

interface StreamReader<R> {
	read(): Promise<StreamReadResult<R>>;
	cancel(reason?: unknown): Promise<void>;
}

interface StreamController<R> {
	enqueue(chunk: R): void;
	close(): void;
	error(reason?: unknown): void;
	/** How much more a consumer will take before backpressure; null when it is not reading. */
	readonly desiredSize: number | null;
}

interface ReadableStream<R> {
	getReader(): StreamReader<R>;
	cancel(reason?: unknown): Promise<void>;
}

declare class ReadableStream<R = unknown> {
	constructor(source?: {
		start?(controller: StreamController<R>): void;
		cancel?(reason?: unknown): void;
	});
}

interface Response {
	readonly ok: boolean;
	readonly status: number;
	readonly headers: FetchHeaders;
	readonly body: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
	json(): Promise<unknown>;
}

declare class Response {
	constructor(
		body?: string | Uint8Array | ReadableStream<Uint8Array> | null,
		init?: ResponseInit,
	);
}

declare function fetch(input: string, init?: FetchInit): Promise<Response>;

/**
 * The HTTP surface the protocol handler takes and answers (step 6): a request's
 * method, URL, headers and body, and the pieces of a URL used to read a query.
 * All web-standard on Workers and Node; declared only as far as is used, as above.
 */
interface RequestInit {
	method?: string;
	headers?: Record<string, string> | Headers;
	body?: string;
}

declare class Request {
	constructor(input: string, init?: RequestInit);
	readonly url: string;
	readonly method: string;
	readonly headers: FetchHeaders;
	readonly body: ReadableStream<Uint8Array> | null;
	text(): Promise<string>;
}

declare class URL {
	constructor(input: string, base?: string);
	readonly pathname: string;
	readonly searchParams: URLSearchParams;
}

declare class URLSearchParams {
	get(name: string): string | null;
}

/**
 * The socket's slice (step 8, docs/implementation/08-websocket.md). `WebSocketPair`
 * is Cloudflare's, not web-standard, and it is declared here because the session
 * object is core code that a Worker's Durable Object delegates to. The name is
 * `WebSocket` rather than one of its own so the workerd program, which takes its
 * globals from the Workers types and does not see this file (decision 125), has it
 * too — one name in both programs, which is the same trick `Request` and `Response`
 * use.
 */
interface WebSocket {
	send(data: string): void;
	close(code?: number, reason?: string): void;
	/** Per-connection state that survives hibernation, under the platform's cap. */
	serializeAttachment(value: unknown): void;
	deserializeAttachment(): unknown;
}

declare const WebSocketPair: { new (): { 0: WebSocket; 1: WebSocket } };

interface ResponseInit {
	status?: number;
	headers?: Record<string, string> | FetchHeaders;
	/** A 101 response carries the server's end of the pair. */
	webSocket?: WebSocket;
}

declare class Response {
	readonly webSocket: WebSocket | null;
}
