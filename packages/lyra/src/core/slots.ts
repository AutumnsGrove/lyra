/**
 * Storage, secrets and waking: the three slots a host fills (decision 12).
 *
 * Storage deals in JSON lines rather than objects, so the core owns encoding
 * and decoding and everything crossing the boundary is validated in one place
 * (docs/implementation/01-core-with-fakes.md, "Storage deals in lines").
 * Adapters stay dumb: save this line, read every line back.
 */

import type { Result } from "./result.js";

export interface StorageSlot {
	/** Append one line. The returned `seq` is its zero-based position. */
	append(line: string): Promise<Result<{ seq: number }>>;
	/** Every line, in the order it was saved, exactly as saved. */
	read(): Promise<Result<string[]>>;
}

export interface SecretsSlot {
	/** A key by name, or nothing when it is not held. A tool never sees the rest. */
	get(name: string): Promise<string | undefined>;
}

export interface WakingSlot {
	schedule(runId: string, atMs: number): Promise<void>;
	cancel(runId: string): Promise<void>;
}
