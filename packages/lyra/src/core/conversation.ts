/**
 * One conversation, as a model sees it.
 *
 * This is the shape the Model slot sends and the record replays to
 * (docs/run-record.md). It carries no token, no tenant and no quota idea: the
 * core must not learn Lumen's vocabulary (docs/adapters.md, "What it costs").
 */

import type { ToolCall } from "./model.js";

export interface UserMessage {
	role: "user";
	text: string;
}

export interface AssistantMessage {
	role: "assistant";
	text: string;
	/** Present only when the model volunteered it (decision 33). */
	reasoning?: string;
	toolCalls: ToolCall[];
}

export interface ToolMessage {
	role: "tool";
	toolCallId: string;
	/** What the model reads. An error is a result it corrects, not a crash (decision 21). */
	content: string;
	isError: boolean;
}

export type ConversationMessage = UserMessage | AssistantMessage | ToolMessage;
