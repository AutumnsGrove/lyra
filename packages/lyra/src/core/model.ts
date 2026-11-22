/**
 * The Model slot: the one contract every model adapter meets.
 *
 * Lumen's adapter, the OpenAI-style adapter and the scripted fake all answer a
 * `ModelRequest` with a `ModelReply`. The request carries no task, no tier, no
 * tenant and no quota idea, so an adapter cannot leak its host into the core
 * (docs/adapters.md, "What it costs").
 */

import type { ConversationMessage } from "./conversation.js";
import type { JsonObject } from "./json.js";
import type { LyraError, Result } from "./result.js";

/**
 * Tokens are always reported. Cost only when it is known, and it says where it
 * came from, because an allowance and a provider invoice are not the same thing
 * (docs/adapters.md, decision 15).
 */
export interface Usage {
	inputTokens: number;
	outputTokens: number;
	cost?: {
		amount: number;
		currency: "USD";
		source: "provider" | "allowance" | "catalog";
	};
}

export type FinishReason = "stop" | "length" | "tool_calls" | "content_filter" | "other";

/** A JSON Schema object, as plain data. Validating it is step 3's job. */
export interface ToolSpec {
	name: string;
	description: string;
	parameters: JsonObject;
}

/**
 * A tool request from the model. `arguments` stays raw text: a model can send
 * invalid JSON, and that is a fact of life the loop hands back, not a crash.
 */
export interface ToolCall {
	id: string;
	name: string;
	arguments: string;
}

export interface ModelRequest {
	system: string;
	messages: ConversationMessage[];
	tools: ToolSpec[];
	/** Lets a recipe name a fallback model (decision 58). */
	model?: string;
	/**
	 * What this request is for, so an adapter and a fake can tell a summary from a
	 * turn: a compaction asks the model about the run rather than continuing it
	 * (docs/context-size.md, decision 40). Absent means an ordinary turn.
	 */
	purpose?: "compaction";
	signal: AbortSignal;
}

export interface ModelReply {
	text: string;
	reasoning?: string;
	toolCalls: ToolCall[];
	usage: Usage;
	finishReason: FinishReason;
	model: string;
}

/** A model failure. `retryable` is what step 2 reads to decide whether to try again. */
export interface ModelError extends LyraError {
	retryable: boolean;
	retryAfterMs?: number;
}

export interface ModelSlot {
	complete(request: ModelRequest): Promise<Result<ModelReply, ModelError>>;
	/**
	 * How many tokens this model can read at once, when the slot knows it (decision
	 * 41). A slot that does not say, and a recipe that does not override it, means
	 * compaction never fires on its own: the run has no number to compare against.
	 */
	contextWindow?: number;
}
