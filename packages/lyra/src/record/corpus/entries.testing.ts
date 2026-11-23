import type { RecordEntry, RecordHeader } from "../entries.js";

/**
 * The record shapes the corpus cases are built from, in one place.
 *
 * Four targets (`truncate`, `load`, `events`, `compaction`) take a `RecordEntry` or
 * a whole record, and a literal entry is seven to nine required fields. Writing
 * them once means a case reads as "a failed tool message" rather than as a wall of
 * JSON, and a field the format adds only has to be added here (issue #41).
 *
 * These are plain values, not generators: a corpus case is a fixed input, and the
 * point of it is that it never changes unless somebody changes it on purpose.
 */

/** A header with a tenant and no recipe pin, which is the shape a load must accept. */
export const header: RecordHeader = {
	type: "header",
	v: 1,
	run: "run-1",
	task: "timeline",
	startedAt: 1_700_000_000_000,
	host: "test",
	tenant: "tenant-1",
};

export const entries = {
	"a-user-message": {
		type: "user_message",
		id: "e1",
		parent: null,
		ts: 1_700_000_000_001,
		label: "task",
		text: "summarize the day",
	},
	"an-assistant-message-with-two-calls": {
		type: "assistant_message",
		id: "e2",
		parent: "e1",
		ts: 1_700_000_000_002,
		text: "checking the repository",
		toolCalls: [
			{ id: "c1", name: "get_commits", arguments: '{"repo":"lyra"}' },
			{ id: "c2", name: "get_issues", arguments: '{"repo":"lyra"}' },
		],
		model: "test/model",
		usage: { inputTokens: 120, outputTokens: 30 },
		finishReason: "tool_calls",
	},
	"a-tool-message": {
		type: "tool_message",
		id: "e3",
		parent: "e2",
		ts: 1_700_000_000_003,
		toolCallId: "c1",
		isError: false,
		content: "12 commits",
		details: { count: 12 },
	},
	"a-tool-message-that-failed": {
		type: "tool_message",
		id: "e4",
		parent: "e3",
		ts: 1_700_000_000_004,
		toolCallId: "c2",
		isError: true,
		content: "the repository was not found",
	},
	"a-status-entry": {
		type: "status",
		id: "e5",
		parent: "e4",
		ts: 1_700_000_000_005,
		state: "done",
	},
	"a-parked-status": {
		type: "status",
		id: "e10",
		parent: "e1",
		ts: 1_700_000_000_011,
		state: "parked",
		reason: "stopped",
	},
	"a-compaction-entry": {
		type: "compaction",
		id: "e6",
		parent: "e5",
		ts: 1_700_000_000_006,
		summary: "The run fetched the day's commits and issues.",
		firstKept: "e5",
		replaces: 4,
		usage: { inputTokens: 400, outputTokens: 60 },
		model: "test/model",
		trigger: "auto",
		instructionsHash: "sha256:0000",
	},
	// The next three stand alone, with no parent: a record of one entry is what the
	// cap test loads, and a dangling parent is a note the loader writes.
	"a-standalone-tool-message": {
		type: "tool_message",
		id: "t1",
		parent: null,
		ts: 1_700_000_000_010,
		toolCallId: "c1",
		isError: false,
		content: "12 commits",
	},
	"a-tool-message-with-a-huge-content": {
		type: "tool_message",
		id: "e8",
		parent: null,
		ts: 1_700_000_000_008,
		toolCallId: "c1",
		isError: false,
		content: "x".repeat(4_000),
		details: { count: 12 },
	},
	"an-assistant-message-with-a-long-reasoning": {
		type: "assistant_message",
		id: "e9",
		parent: null,
		ts: 1_700_000_000_009,
		text: "here is the answer",
		reasoning: "y".repeat(4_000),
		toolCalls: [],
		model: "test/model",
		usage: { inputTokens: 10, outputTokens: 5 },
		finishReason: "stop",
	},
} as const satisfies Record<string, RecordEntry>;

/** The entries in record order, which is the order a projection expects. */
export const record: readonly RecordEntry[] = [
	entries["a-user-message"],
	entries["an-assistant-message-with-two-calls"],
	entries["a-tool-message"],
	entries["a-tool-message-that-failed"],
	entries["a-status-entry"],
	entries["a-compaction-entry"],
];
