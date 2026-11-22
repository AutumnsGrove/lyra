import fc from "fast-check";

import type { JsonValue } from "./json.js";
import type {
	AssistantMessageEntry,
	NoteEntry,
	RecordEntry,
	StatusEntry,
	ToolMessageEntry,
	UserMessageEntry,
} from "../record/entries.js";

/**
 * Generators for compaction's property and fuzz tests (CMP02 and CMP05 in
 * `docs/context-size.md`).
 *
 * A history these build is one a record could really hold: a task message, then
 * steps that are a user message or an assistant turn whose calls all have their
 * results, with the entries a reader skips (status, note) sprinkled in. That is
 * the shape the cut has to respect, so the property is about whole steps rather
 * than about any list of entries at all.
 *
 * This file is test support, not test or library code, so it is excluded from the
 * build and from coverage, and it may import the dev tooling.
 */

interface Step {
	kind: "user" | "turn";
	text: string;
	reasoning?: string | undefined;
	/** One result per call, in order. Empty for a turn with no calls. */
	results: string[];
}

const stepArbitrary: fc.Arbitrary<Step> = fc.oneof(
	fc.record({
		kind: fc.constant("user" as const),
		text: fc.string({ maxLength: 60 }),
		results: fc.constant([] as string[]),
	}),
	fc.record({
		kind: fc.constant("turn" as const),
		text: fc.string({ maxLength: 60 }),
		reasoning: fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
		results: fc.array(fc.string({ maxLength: 80 }), { maxLength: 3 }),
	}),
);

/** Ids are positional and the chain links to the entry before, so a path always loads. */
function materialise(steps: readonly Step[], skipEvery: number): RecordEntry[] {
	const entries: RecordEntry[] = [];
	let nextId = 1;
	let nextCall = 1;
	const link = (): string | null => entries.at(-1)?.id ?? null;

	const push = (entry: RecordEntry): void => {
		entries.push(entry);
	};
	const status = (): StatusEntry => ({
		type: "status",
		id: `e${nextId++}`,
		parent: link(),
		ts: 1,
		state: "running",
	});
	const note = (): NoteEntry => ({
		type: "note",
		id: `e${nextId++}`,
		parent: link(),
		ts: 1,
		kind: "generated",
		text: "",
	});

	const task: UserMessageEntry = {
		type: "user_message",
		id: `e${nextId++}`,
		parent: null,
		ts: 1,
		label: "task",
		text: "do the thing",
	};
	push(task);
	push(status());

	for (const [index, step] of steps.entries()) {
		if (skipEvery > 0 && index > 0 && index % skipEvery === 0) {
			push(note());
			push(status());
		}
		if (step.kind === "user") {
			const entry: UserMessageEntry = {
				type: "user_message",
				id: `e${nextId++}`,
				parent: link(),
				ts: 1,
				label: "follow_up",
				text: step.text,
			};
			push(entry);
			continue;
		}
		const calls = step.results.map(() => {
			const id = `c${nextCall++}`;
			return { id, name: "read", arguments: JSON.stringify({ id }) };
		});
		const assistant: AssistantMessageEntry = {
			type: "assistant_message",
			id: `e${nextId++}`,
			parent: link(),
			ts: 1,
			text: step.text,
			toolCalls: calls,
			model: "generated/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: calls.length > 0 ? "tool_calls" : "stop",
		};
		if (step.reasoning !== undefined) {
			assistant.reasoning = step.reasoning;
		}
		push(assistant);
		for (const [position, content] of step.results.entries()) {
			const result: ToolMessageEntry = {
				type: "tool_message",
				id: `e${nextId++}`,
				parent: link(),
				ts: 1,
				toolCallId: (calls[position] as { id: string }).id,
				isError: false,
				content,
			};
			push(result);
		}
	}

	return entries;
}

/** A history a real record could hold, with the reader-skipped entries mixed in. */
export function historyArbitrary(): fc.Arbitrary<RecordEntry[]> {
	const steps = fc.array(stepArbitrary, { maxLength: 6 });
	return fc
		.tuple(steps, fc.constantFrom(0, 2, 3))
		.map(([generated, skipEvery]) => materialise(generated, skipEvery));
}

/** One entry whose text is arbitrary, for the fuzz target: it must never throw. */
export function hostileEntryArbitrary(): fc.Arbitrary<RecordEntry> {
	const text = fc.string({ maxLength: 4000 });
	return fc.oneof(
		text.map((content): ToolMessageEntry => ({
			type: "tool_message",
			id: "e1",
			parent: null,
			ts: 0,
			toolCallId: "c1",
			isError: false,
			content,
		})),
		fc.array(text, { maxLength: 4 }).map((texts): AssistantMessageEntry => ({
			type: "assistant_message",
			id: "e1",
			parent: null,
			ts: 0,
			text: texts[0] ?? "",
			toolCalls: texts.slice(1).map((argumentsText, index) => ({
				id: `c${index}`,
				name: "read",
				arguments: argumentsText,
			})),
			model: "generated/model",
			usage: { inputTokens: 0, outputTokens: 0 },
			finishReason: "stop",
		})),
		text.map((content): UserMessageEntry => ({
			type: "user_message",
			id: "e1",
			parent: null,
			ts: 0,
			label: "task",
			text: content,
		})),
	);
}
