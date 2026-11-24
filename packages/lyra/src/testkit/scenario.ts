/**
 * The scenario runner, in-process (docs/engineering-practices.md, SCN01 to SCN03).
 *
 * A scenario is a small file: what the fake model does on each turn, which tools
 * the task has, what was asked, and what should happen. The same files run here
 * against the core now and over the protocol in step 6, so the vocabulary in them
 * is the protocol's where there is one (`call_id`, `is_error`), and this runner
 * translates it onto the in-process events.
 *
 * It takes an already-parsed object, because `src/` may not import `node:fs`. The
 * decoding is hand-written like everything else at a boundary, and a bad file is
 * refused with a message naming the field.
 */

import type { FakeClock } from "./clock.js";
import type { ModelSlot } from "../core/model.js";
import type { RunEvent } from "../core/events.js";
import { isJsonValue, isPlainObject, type JsonObject, type JsonValue } from "../core/json.js";
import type { CompactionSettings } from "../core/compaction.js";
import { TOOL_POLICIES, isToolPolicy, type ToolPolicy } from "../core/approval.js";
import { isFinishReason } from "../core/decode-reply.js";
import type { FinishReason } from "../core/model.js";
import { fail, isErrorCode, ok, type Result } from "../core/result.js";
import { compileSchema, formatErrors, validateValue, type Validation } from "../core/schema.js";
import { runTask, type RunResult } from "../core/run.js";
import type { Ids } from "../core/clock.js";
import type { Recipe } from "../core/define-recipe.js";
import type { Tool } from "../core/tool.js";
import { counterIds } from "../adapters/memory/ids.js";
import { memoryStorage, type MemoryStorage } from "../adapters/memory/storage.js";
import type { RecordEntry } from "../record/entries.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
import { replayConversation } from "../record/replay.js";
import { fakeClock } from "./clock.js";
import { timelineTestRecipe } from "./timeline-recipe.js";
import {
	scriptedModel,
	type ScriptedFailure,
	type ScriptedModelOptions,
	type ScriptedToolCall,
	type ScriptedTurn,
} from "./model.js";
import {
	createFinishTool,
	toolAsking,
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
	type ScriptedToolOptions,
} from "./tools.js";

export type ScenarioToolBehavior = "ok" | "error" | "throw" | "slow" | "ask";

export interface ScenarioTool {
	name: string;
	behavior: ScenarioToolBehavior;
	/** Allow, ask or deny, which is what an approval needs to exercise (decision 35). */
	policy?: ToolPolicy;
	/** Whether this tool may run beside the other calls of its reply (decision 154). */
	parallel?: boolean;
	content?: string;
	/** For a `slow` tool: how long it takes on the fake clock. */
	ms?: number;
	/** For an `ask` tool: the question it needs a person to answer (decision 34). */
	question?: { title: string; message: string };
}

/** An expectation is matched as a subset, so extra fields on the actual value are fine. */
export type Expectation = Record<string, unknown>;

/**
 * A person's answer to the request a run parked on, as a scenario names it. The
 * request is the one outstanding in the record; a scenario cannot name an id it
 * would have to guess, and it does not need to: it is talking about its own run.
 */
export interface ScenarioAnswer {
	/** Approve or deny an approval, or what a question is answered with. */
	decision?: "approve" | "deny";
	/** The note a deny carries, which the model reads (decision 34). */
	note?: string;
	/** The text a question is answered with. */
	text?: string;
}

/**
 * One run of a scenario's conversation, in the order the person drove it. A step
 * either starts (or continues after an answer) the run that is going, or begins
 * the next one with a follow-up. Every step carries its own script, because turns
 * are consumed per run.
 */
export interface ScenarioRun {
	/** The fake model's turns for this run. */
	model: ScriptedTurn[];
	/** This step begins the next run in the session, with the person's words. */
	followUp?: string;
	/** This step answers the request the run parked on, then continues that run. */
	answer?: ScenarioAnswer;
}

/** A scenario that compacts: the recipe's settings, and the answers to its summary. */
export interface ScenarioCompaction {
	settings: CompactionSettings;
	summaries: ScriptedTurn[];
}

export interface Scenario {
	name: string;
	task: string;
	system: string;
	/** The task's input: a text message, or a recipe's own JSON input. */
	input: JsonValue;
	/** A testkit recipe to run instead of the inline tools. */
	recipe?: string;
	tools: ScenarioTool[];
	/** The single run's script. Empty when the file drives a conversation instead. */
	model: ScriptedTurn[];
	/**
	 * The runs of one session, in order, when a file describes a conversation rather
	 * than one run (SCN07). Absent for the single-run shape, which is unchanged.
	 */
	runs?: ScenarioRun[];
	expectEvents: Expectation[];
	expectRecord: Expectation[];
	/** Stop the run when the nth event arrives, for the stop scenarios. */
	abortAfter?: number;
	/** How the run compacts, and how its summaries are answered. */
	compaction?: ScenarioCompaction;
	/** How many calls may run at once, when the file sets a cap (decision 154). */
	maxParallelCalls?: number;
}

export interface ScenarioOutcome {
	/** The last run's result, so a single-run file reads as it always did. */
	result: RunResult;
	/** One result per run, in order, with a resumed run's result replaced by its end. */
	results: RunResult[];
	events: RunEvent[];
	/** Absent when the record could not be read or did not load. */
	record?: LoadedRecord;
	/** What did not match. Empty means the scenario passed. */
	problems: string[];
}

const BEHAVIORS: readonly ScenarioToolBehavior[] = ["ok", "error", "throw", "slow", "ask"];
const FINISH_REASONS: readonly FinishReason[] = [
	"stop",
	"length",
	"tool_calls",
	"content_filter",
	"other",
];

/** The protocol's spelling of a field, and the in-process event's. */
const FIELD_NAMES: Record<string, string> = {
	call_id: "callId",
	is_error: "isError",
	finish_reason: "finishReason",
	parked_reason: "parkedReason",
};

function isBehavior(value: unknown): value is ScenarioToolBehavior {
	return BEHAVIORS.some((known) => known === value);
}

function bad(problem: string): Result<never> {
	return fail("bad_request", problem);
}

function stringField(value: Record<string, unknown>, key: string, where: string): Result<string> {
	const field = value[key];
	if (typeof field !== "string") {
		return bad(`${where}.${key} must be a string`);
	}
	return ok(field);
}

function optionalString(
	value: Record<string, unknown>,
	key: string,
	where: string,
): Result<string | undefined> {
	const field = value[key];
	if (field === undefined) {
		return ok(undefined);
	}
	if (typeof field !== "string") {
		return bad(`${where}.${key} must be a string when it is there`);
	}
	return ok(field);
}

function decodeTurn(value: unknown, where: string): Result<ScriptedTurn> {
	if (!isPlainObject(value)) {
		return bad(`${where} must be an object`);
	}
	const turn: ScriptedTurn = {};
	const text = optionalString(value, "text", where);
	if (!text.ok) {
		return text;
	}
	if (text.value !== undefined) {
		turn.text = text.value;
	}
	const reasoning = optionalString(value, "reasoning", where);
	if (!reasoning.ok) {
		return reasoning;
	}
	if (reasoning.value !== undefined) {
		turn.reasoning = reasoning.value;
	}

	const rawCalls = value["tool_calls"];
	if (rawCalls !== undefined) {
		if (!Array.isArray(rawCalls)) {
			return bad(`${where}.tool_calls must be a list`);
		}
		const calls: ScriptedToolCall[] = [];
		for (const [index, raw] of rawCalls.entries()) {
			const callWhere = `${where}.tool_calls[${index}]`;
			if (!isPlainObject(raw)) {
				return bad(`${callWhere} must be an object`);
			}
			const id = stringField(raw, "id", callWhere);
			if (!id.ok) {
				return id;
			}
			const name = stringField(raw, "name", callWhere);
			if (!name.ok) {
				return name;
			}
			const call: ScriptedToolCall = { id: id.value, name: name.value };
			if (raw["args"] !== undefined) {
				call.args = raw["args"];
			}
			calls.push(call);
		}
		turn.toolCalls = calls;
	}

	const finishReason = value["finish_reason"];
	if (finishReason !== undefined) {
		if (!isFinishReason(finishReason)) {
			return bad(`${where}.finish_reason must be one of ${FINISH_REASONS.join(", ")}`);
		}
		turn.finishReason = finishReason;
	}

	const delay = value["delay_ms"];
	if (delay !== undefined) {
		if (typeof delay !== "number" || !Number.isFinite(delay) || delay < 0) {
			return bad(`${where}.delay_ms must be a number of milliseconds`);
		}
		turn.delayMs = delay;
	}

	const rawUsage = value["usage"];
	if (rawUsage !== undefined) {
		if (!isPlainObject(rawUsage)) {
			return bad(`${where}.usage must be an object`);
		}
		const input = rawUsage["input_tokens"];
		const output = rawUsage["output_tokens"];
		if (typeof input !== "number" || typeof output !== "number") {
			return bad(`${where}.usage needs input_tokens and output_tokens`);
		}
		turn.usage = { inputTokens: input, outputTokens: output };
	}

	const rawFailures = value["failures"];
	if (rawFailures !== undefined) {
		if (!Array.isArray(rawFailures)) {
			return bad(`${where}.failures must be a list`);
		}
		const failures: ScriptedFailure[] = [];
		for (const raw of rawFailures) {
			if (!isPlainObject(raw)) {
				return bad(`${where}.failures must hold objects`);
			}
			const failure: ScriptedFailure = {};
			const code = raw["code"];
			if (code !== undefined) {
				if (!isErrorCode(code)) {
					return bad(`${where}.failures.code must be an error code`);
				}
				failure.code = code;
			}
			const message = raw["message"];
			if (message !== undefined) {
				if (typeof message !== "string") {
					return bad(`${where}.failures.message must be a string`);
				}
				failure.message = message;
			}
			if (typeof raw["retryable"] === "boolean") {
				failure.retryable = raw["retryable"];
			}
			failures.push(failure);
		}
		turn.failures = failures;
	}

	return ok(turn);
}

/** The scenario words for the settings, and the field each one sets. */
const COMPACTION_FIELDS: readonly (readonly [string, keyof CompactionSettings])[] = [
	["context_window", "contextWindow"],
	["reserve_tokens", "reserveTokens"],
	["keep_tokens", "keepTokens"],
];

function decodeCompaction(value: unknown): Result<ScenarioCompaction> {
	if (!isPlainObject(value)) {
		return bad("scenario.compaction must be an object");
	}
	const settings: CompactionSettings = {};
	for (const [word, field] of COMPACTION_FIELDS) {
		const raw = value[word];
		if (raw === undefined) {
			continue;
		}
		if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 0) {
			return bad(`scenario.compaction.${word} must be a whole number of tokens`);
		}
		if (field === "contextWindow") {
			settings.contextWindow = raw;
		} else if (field === "reserveTokens") {
			settings.reserveTokens = raw;
		} else {
			settings.keepTokens = raw;
		}
	}
	const rawSummaries = value["summaries"];
	if (!Array.isArray(rawSummaries) || rawSummaries.length === 0) {
		return bad("scenario.compaction.summaries must be a non-empty list of turns");
	}
	const summaries: ScriptedTurn[] = [];
	for (const [index, raw] of rawSummaries.entries()) {
		const turn = decodeTurn(raw, `scenario.compaction.summaries[${index}]`);
		if (!turn.ok) {
			return turn;
		}
		summaries.push(turn.value);
	}
	return ok({ settings, summaries });
}

function decodeExpectations(value: unknown, where: string): Result<Expectation[]> {
	if (value === undefined) {
		return ok([]);
	}
	if (!Array.isArray(value)) {
		return bad(`${where} must be a list`);
	}
	const expectations: Expectation[] = [];
	for (const [index, raw] of value.entries()) {
		if (!isPlainObject(raw)) {
			return bad(`${where}[${index}] must be an object`);
		}
		expectations.push(raw);
	}
	return ok(expectations);
}

export function decodeScenario(value: unknown): Result<Scenario> {
	if (!isPlainObject(value)) {
		return bad("a scenario must be an object");
	}

	const name = stringField(value, "name", "scenario");
	if (!name.ok) {
		return name;
	}
	const rawInput = value["input"];
	if (rawInput === undefined || !isJsonValue(rawInput)) {
		return bad("scenario.input must be there, and JSON");
	}
	const recipe = optionalString(value, "recipe", "scenario");
	if (!recipe.ok) {
		return recipe;
	}
	// The name is not checked here: a host brings its own recipe to `runScenario`,
	// and the decoder only knows what a file looks like (issue #59). An empty name is
	// still a malformed file, and a name nobody provided is the host's mistake, which
	// `runScenario` says out loud rather than reporting as a scenario that failed.
	if (recipe.value !== undefined && recipe.value.trim() === "") {
		return bad("scenario.recipe must be a recipe's name");
	}
	if (recipe.value === undefined && typeof rawInput !== "string") {
		return bad("scenario.input must be a string when no recipe is named");
	}
	if (recipe.value !== undefined && value["tools"] !== undefined) {
		return bad("scenario.tools cannot be given with a recipe");
	}
	const task = optionalString(value, "task", "scenario");
	if (!task.ok) {
		return task;
	}
	const system = optionalString(value, "system", "scenario");
	if (!system.ok) {
		return system;
	}

	const tools: ScenarioTool[] = [];
	const rawTools = value["tools"];
	if (rawTools !== undefined) {
		if (!Array.isArray(rawTools)) {
			return bad("scenario.tools must be a list");
		}
		for (const [index, raw] of rawTools.entries()) {
			const where = `scenario.tools[${index}]`;
			if (!isPlainObject(raw)) {
				return bad(`${where} must be an object`);
			}
			const toolName = stringField(raw, "name", where);
			if (!toolName.ok) {
				return toolName;
			}
			const behavior = raw["behavior"];
			if (!isBehavior(behavior)) {
				return bad(`${where}.behavior must be one of ${BEHAVIORS.join(", ")}`);
			}
			const tool: ScenarioTool = { name: toolName.value, behavior };
			const policy = raw["policy"];
			if (policy !== undefined) {
				if (!isToolPolicy(policy)) {
					return bad(`${where}.policy must be one of ${TOOL_POLICIES.join(", ")}`);
				}
				tool.policy = policy;
			}
			const parallel = raw["parallel"];
			if (parallel !== undefined) {
				if (typeof parallel !== "boolean") {
					return bad(`${where}.parallel must be true or false`);
				}
				tool.parallel = parallel;
			}
			const content = optionalString(raw, "content", where);
			if (!content.ok) {
				return content;
			}
			if (content.value !== undefined) {
				tool.content = content.value;
			}
			const ms = raw["ms"];
			if (ms !== undefined) {
				if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
					return bad(`${where}.ms must be a number of milliseconds`);
				}
				tool.ms = ms;
			}
			const question = raw["question"];
			if (question !== undefined) {
				if (!isPlainObject(question)) {
					return bad(`${where}.question must be an object`);
				}
				const title = stringField(question, "title", `${where}.question`);
				if (!title.ok) {
					return title;
				}
				const message = stringField(question, "message", `${where}.question`);
				if (!message.ok) {
					return message;
				}
				tool.question = { title: title.value, message: message.value };
			}
			if (behavior === "ask" && tool.question === undefined) {
				return bad(`${where} asks a question, so it needs a question`);
			}
			tools.push(tool);
		}
	}

	const rawRuns = value["runs"];
	const runs = rawRuns === undefined ? undefined : decodeRuns(rawRuns);
	if (runs !== undefined && !runs.ok) {
		return runs;
	}
	const rawModel = value["model"];
	const model: ScriptedTurn[] = [];
	if (rawModel !== undefined || runs === undefined) {
		if (!Array.isArray(rawModel) || rawModel.length === 0) {
			return bad("scenario.model must be a non-empty list of turns");
		}
		for (const [index, raw] of rawModel.entries()) {
			const turn = decodeTurn(raw, `scenario.model[${index}]`);
			if (!turn.ok) {
				return turn;
			}
			model.push(turn.value);
		}
	}
	if (runs !== undefined && value["abort_after"] !== undefined) {
		// One controller is aborted once and stays aborted, so every segment after the
		// stop would begin stopped. A stop belongs to one run rather than to a
		// conversation, and a file cannot mean both.
		return bad("scenario.abort_after cannot be combined with scenario.runs");
	}
	if (runs !== undefined && model.length > 0) {
		// Two scripts for one file is ambiguous, and the silent winner would be whichever
		// the runner happened to read, so the file says which it means.
		return bad("scenario.model and scenario.runs cannot both be set");
	}

	const expectEvents = decodeExpectations(value["expect_events"], "scenario.expect_events");
	if (!expectEvents.ok) {
		return expectEvents;
	}
	const expectRecord = decodeExpectations(value["expect_record"], "scenario.expect_record");
	if (!expectRecord.ok) {
		return expectRecord;
	}

	const scenario: Scenario = {
		name: name.value,
		task: task.value ?? "scenario",
		system: system.value ?? "you are being tested",
		input: rawInput,
		tools,
		model,
		expectEvents: expectEvents.value,
		expectRecord: expectRecord.value,
	};
	if (recipe.value !== undefined) {
		scenario.recipe = recipe.value;
	}
	if (runs !== undefined && runs.ok) {
		scenario.runs = runs.value;
	}

	const rawCompaction = value["compaction"];
	if (rawCompaction !== undefined) {
		const compaction = decodeCompaction(rawCompaction);
		if (!compaction.ok) {
			return compaction;
		}
		scenario.compaction = compaction.value;
	}

	const maxParallelCalls = value["max_parallel_calls"];
	if (maxParallelCalls !== undefined) {
		if (
			typeof maxParallelCalls !== "number" ||
			!Number.isSafeInteger(maxParallelCalls) ||
			maxParallelCalls < 1
		) {
			return bad("scenario.max_parallel_calls must be a positive whole number");
		}
		scenario.maxParallelCalls = maxParallelCalls;
	}

	const abortAfter = value["abort_after"];
	if (abortAfter !== undefined) {
		if (typeof abortAfter !== "number" || !Number.isInteger(abortAfter) || abortAfter < 1) {
			return bad("scenario.abort_after must be a whole number of events");
		}
		scenario.abortAfter = abortAfter;
	}

	return ok(scenario);
}

export function makeScenarioTool(tool: ScenarioTool, clock: ReturnType<typeof fakeClock>): Tool {
	const options: ScriptedToolOptions = {};
	if (tool.policy !== undefined) {
		options.policy = tool.policy;
	}
	if (tool.parallel === true) {
		options.parallel = true;
	}
	switch (tool.behavior) {
		case "error":
			return toolReturningError(tool.name, tool.content ?? `${tool.name} says no`, options);
		case "throw":
			return toolThatThrows(tool.name, tool.content ?? `${tool.name} broke`, options);
		case "slow":
			return toolTakingTime(tool.name, tool.ms ?? 100, clock, options);
		case "ask":
			// The question is the call's result once a person answers it (decision 34).
			return toolAsking(
				tool.name,
				{
					kind: "question",
					title: tool.question?.title ?? `About ${tool.name}`,
					message: tool.question?.message ?? `What should ${tool.name} do?`,
				},
				options,
			);
		case "ok":
			return toolReturning(tool.name, tool.content ?? `${tool.name} says yes`, options);
	}
}

/** Compare an expectation with an actual value as a subset, collecting what differs. */
function compare(expected: unknown, actual: unknown, where: string, problems: string[]): void {
	if (Array.isArray(expected)) {
		if (!Array.isArray(actual) || actual.length !== expected.length) {
			problems.push(
				`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
			);
			return;
		}
		for (const [index, item] of expected.entries()) {
			compare(item, actual[index], `${where}[${index}]`, problems);
		}
		return;
	}
	if (isPlainObject(expected)) {
		if (!isPlainObject(actual)) {
			problems.push(`${where}: expected an object, got ${JSON.stringify(actual)}`);
			return;
		}
		for (const [key, wanted] of Object.entries(expected)) {
			const actualKey = FIELD_NAMES[key] ?? key;
			compare(wanted, actual[actualKey], `${where}.${key}`, problems);
		}
		return;
	}
	if (expected !== actual) {
		problems.push(
			`${where}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
		);
	}
}

/** How many of an expectation's own fields the value already agrees with, to pick the closest. */
function closeness(expected: Expectation, actual: unknown): number {
	if (!isPlainObject(actual)) {
		return 0;
	}
	let score = 0;
	for (const [key, wanted] of Object.entries(expected)) {
		const actualKey = FIELD_NAMES[key] ?? key;
		if (actual[actualKey] === wanted) {
			score += 1;
		}
	}
	return score;
}

function describeEvent(event: { type: string } | undefined): string {
	return event === undefined ? "none" : JSON.stringify(event).slice(0, 200);
}

/**
 * Events are matched as a subsequence, so an unrelated new event does not break a
 * scenario. Exported because the workerd runner matches protocol events with it,
 * and one matcher is what keeps the two levels honest.
 */
export function matchScenarioEvents(
	expected: Expectation[],
	events: readonly { type: string }[],
	problems: string[],
): void {
	let cursor = 0;
	for (const expectation of expected) {
		let found = -1;
		/** The first event that was close, so the failure says what differed rather than only what was wanted. */
		let closest: string | undefined;
		let best = -1;
		for (let index = cursor; index < events.length; index += 1) {
			const event = events[index];
			if (event === undefined) {
				continue;
			}
			const differences: string[] = [];
			compare(expectation, event, "", differences);
			if (differences.length === 0) {
				found = index;
				break;
			}
			// The event that agrees with the most fields is the one worth quoting.
			const score = closeness(expectation, event);
			if (score > best) {
				best = score;
				closest = `${event.type} differed at ${differences.join("; ")}`;
			}
		}
		if (found === -1) {
			const remaining = events
				.slice(cursor)
				.map((event) => event.type)
				.join(", ");
			problems.push(
				`an event matching ${JSON.stringify(expectation)} never came after event ${cursor} (${remaining === "" ? "nothing left" : `what was left: ${remaining}`}); ${closest ?? "no event came close"}`,
			);
		} else {
			cursor = found + 1;
		}
	}
}

/** Record entries are matched in order, each as a subset of the next entry that fits. */
export function matchScenarioRecord(
	expected: Expectation[],
	record: LoadedRecord,
	problems: string[],
): void {
	let cursor = 0;
	for (const expectation of expected) {
		let found = -1;
		let closest: string | undefined;
		let best = -1;
		for (let index = cursor; index < record.entries.length; index += 1) {
			const entry = record.entries[index];
			if (entry === undefined) {
				continue;
			}
			const differences: string[] = [];
			compare(expectation, entry, "", differences);
			if (differences.length === 0) {
				found = index;
				break;
			}
			const score = closeness(expectation, entry);
			if (score > best) {
				best = score;
				closest = `${entry.type} differed at ${differences.join("; ")}`;
			}
		}
		if (found === -1) {
			const remaining = record.entries
				.slice(cursor)
				.map((entry) => entry.type)
				.join(", ");
			problems.push(
				`no record entry matching ${JSON.stringify(expectation)} came after entry ${cursor} (${remaining === "" ? "nothing left" : `what was left: ${remaining}`}); ${closest ?? "no entry came close"}`,
			);
		} else {
			cursor = found + 1;
		}
	}
}

/**
 * A file's `runs:` list, the shape that describes a conversation rather than one run
 * (SCN07). The first step starts the run; every later step says how it continues,
 * either by answering the request the run parked on or by beginning the next run
 * with a follow-up. Two commands in one step are refused rather than guessed at.
 */
function decodeRuns(value: unknown): Result<ScenarioRun[]> {
	if (!Array.isArray(value) || value.length === 0) {
		return bad("scenario.runs must be a non-empty list of runs");
	}
	const runs: ScenarioRun[] = [];
	for (const [index, raw] of value.entries()) {
		const where = `scenario.runs[${index}]`;
		if (!isPlainObject(raw)) {
			return bad(`${where} must be an object`);
		}
		const followUp = optionalString(raw, "follow_up", where);
		if (!followUp.ok) {
			return followUp;
		}
		const hasAnswer = raw["answer"] !== undefined;
		if (index === 0 && (followUp.value !== undefined || hasAnswer)) {
			return bad(`${where} starts the run, so it cannot answer or follow up`);
		}
		if (followUp.value !== undefined && hasAnswer) {
			return bad(`${where} cannot both answer and follow up`);
		}

		const rawModel = raw["model"];
		if (!Array.isArray(rawModel) || rawModel.length === 0) {
			return bad(`${where}.model must be a non-empty list of turns`);
		}
		const turns: ScriptedTurn[] = [];
		for (const [turnIndex, rawTurn] of rawModel.entries()) {
			const turn = decodeTurn(rawTurn, `${where}.model[${turnIndex}]`);
			if (!turn.ok) {
				return turn;
			}
			turns.push(turn.value);
		}

		const step: ScenarioRun = { model: turns };
		if (followUp.value !== undefined) {
			step.followUp = followUp.value;
		}
		if (hasAnswer) {
			const answer = decodeAnswer(raw["answer"], `${where}.answer`);
			if (!answer.ok) {
				return answer;
			}
			step.answer = answer.value;
		}
		runs.push(step);
	}
	return ok(runs);
}

/** A person's answer, as a file spells it. One of a decision or a text is required. */
function decodeAnswer(value: unknown, where: string): Result<ScenarioAnswer> {
	if (!isPlainObject(value)) {
		return bad(`${where} must be an object`);
	}
	const answer: ScenarioAnswer = {};
	const text = optionalString(value, "text", where);
	if (!text.ok) {
		return text;
	}
	if (text.value !== undefined) {
		answer.text = text.value;
	}
	const note = optionalString(value, "note", where);
	if (!note.ok) {
		return note;
	}
	if (note.value !== undefined) {
		answer.note = note.value;
	}
	const decision = value["decision"];
	if (decision !== undefined) {
		if (decision !== "approve" && decision !== "deny") {
			return bad(`${where}.decision must be approve or deny`);
		}
		answer.decision = decision;
	}
	if (answer.decision === undefined && answer.text === undefined) {
		// An answer with neither decides nothing, and the run it was meant to continue
		// would park again with no explanation.
		return bad(`${where} must carry a decision or a text`);
	}
	if (answer.decision !== undefined && answer.text !== undefined) {
		return bad(`${where} answers with both a decision and a text`);
	}
	return ok(answer);
}

/** The testkit recipes a scenario may name, by name. */
const RECIPES = new Map([[timelineTestRecipe.name, timelineTestRecipe]]);

export interface ScenarioRunOptions {
	/**
	 * A host's own recipes, by name, consulted before the testkit's own (SCN06). A
	 * scenario file names a recipe by name, so a host passes the same map its runtime
	 * uses and the files stay the source of truth (issue #59).
	 */
	recipes?: ReadonlyMap<string, Recipe>;
	/**
	 * How a run gets its model. The default is the in-process scripted model; a test
	 * that wants a real adapter and a fake server passes one here, so a scenario runs
	 * through the wire as well (SCN04).
	 */
	makeModel?: (
		turns: readonly ScriptedTurn[],
		clock: FakeClock,
		options: ScriptedModelOptions,
	) => ModelSlot;
}

/**
 * The model a scenario runs against. A scenario that compacts is scripted by
 * request order, because a compaction folds older turns into a summary and the
 * conversation's length stops counting the turns that were taken.
 */
function modelFor(
	turns: readonly ScriptedTurn[],
	compaction: ScenarioCompaction | undefined,
	clock: FakeClock,
	options: ScenarioRunOptions,
): ModelSlot {
	const settings: ScriptedModelOptions = { clock };
	if (compaction !== undefined) {
		settings.summaries = compaction.summaries;
		settings.position = "sequence";
	}
	if (options.makeModel === undefined) {
		return scriptedModel(turns, settings);
	}
	return options.makeModel(turns, clock, settings);
}

/**
 * The request a record is waiting for, or `undefined` when nothing is outstanding.
 * A conversation file is driven at the wire levels by a harness that has only the
 * record and the protocol, so this is how it finds the request to answer.
 */
export function outstandingRequestOf(record: LoadedRecord): string | undefined {
	// One scan, so the runner and the wire harnesses cannot drift: a rule that grows
	// in one of them would silently not hold in the other.
	return outstandingRequest(record)?.id;
}

/** The request a run parked on, when the record has one still waiting for a person. */
interface OutstandingRequest {
	id: string;
	parent: string | null;
}

function outstandingRequest(record: LoadedRecord): OutstandingRequest | undefined {
	const answered = new Set(
		record.entries.flatMap((entry) =>
			entry.type === "request_answered" ? [entry.request] : [],
		),
	);
	const open = record.entries.filter(
		(entry): entry is Extract<RecordEntry, { type: "request" }> =>
			entry.type === "request" && !answered.has(entry.request),
	);
	const last = open.at(-1);
	if (last === undefined) {
		return undefined;
	}
	// The answer hangs off the end of the record, not off the request: a resume reads
	// the active path, and an entry branching from an older node would leave the
	// park behind (the same rule the session's own answer writer follows).
	const tail = record.entries.at(-1);
	return { id: last.request, parent: tail?.id ?? last.id };
}

/**
 * The check a scenario's input gets, from the recipe's own schema. A file whose input
 * the recipe refuses is a file mistake, so it says so instead of running `setup` with
 * input the host's `start` would have refused with `bad_request`.
 */
function checkScenarioInput(
	schema: JsonObject,
	scenario: Scenario,
): (value: JsonValue) => Validation<JsonValue> {
	let compiled: ReturnType<typeof compileSchema>;
	try {
		compiled = compileSchema(schema, "input");
	} catch (error) {
		throw new Error(
			`the scenario ${scenario.name} names a recipe whose input schema cannot be checked: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const checked = validateValue<JsonValue>(compiled, scenario.input, "input");
	if (!checked.ok) {
		throw new Error(
			`the scenario ${scenario.name} gives input the recipe refuses: ${formatErrors(checked.errors, "invalid input")}`,
		);
	}
	return (value) => validateValue<JsonValue>(compiled, value, "input");
}

/**
 * The recipe a scenario names: a host's own first, then the testkit's. A name nobody
 * provided is a host's mistake rather than a scenario that failed, so it throws with
 * the names that were available instead of reporting a run nobody made.
 */
function recipeFor(scenario: Scenario, options: ScenarioRunOptions): Recipe | undefined {
	if (scenario.recipe === undefined) {
		return undefined;
	}
	const found = options.recipes?.get(scenario.recipe) ?? RECIPES.get(scenario.recipe);
	if (found === undefined) {
		const available = [...(options.recipes?.keys() ?? []), ...RECIPES.keys()].join(", ");
		throw new Error(
			`the scenario ${scenario.name} names the recipe "${scenario.recipe}", and this runner was given ${available === "" ? "none" : available}`,
		);
	}
	return found;
}

export async function runScenario(
	scenario: Scenario,
	options: ScenarioRunOptions = {},
): Promise<ScenarioOutcome> {
	const clock = fakeClock();
	const storage = memoryStorage();
	const ids = counterIds();
	const events: RunEvent[] = [];
	const controller = new AbortController();
	const recipe = recipeFor(scenario, options);
	const tools: Tool[] =
		recipe === undefined
			? [...scenario.tools.map((tool) => makeScenarioTool(tool, clock)), createFinishTool()]
			: [...recipe.tools];

	// A recipe brings its own first message, state and instructions; a plain scenario
	// still sends its input text straight in. Everything the recipe declares goes with
	// it, because a scenario that dropped its limits or its input check could go green
	// where the host's own run parks or refuses (found in review).
	const inputCheck =
		recipe?.input === undefined ? undefined : checkScenarioInput(recipe.input, scenario);
	const recipeParts =
		recipe === undefined
			? {}
			: {
					inputValue: scenario.input,
					...(recipe.setup === undefined ? {} : { setup: recipe.setup }),
					...(inputCheck === undefined ? {} : { inputCheck }),
					...(recipe.limits === undefined ? {} : { limits: recipe.limits }),
					...(recipe.fallbackModel === undefined
						? {}
						: { fallbackModel: recipe.fallbackModel }),
					...(recipe.stuck === undefined ? {} : { stuck: recipe.stuck }),
					...(recipe.compaction === undefined ? {} : { compaction: recipe.compaction }),
					...(recipe.approvals === undefined ? {} : { approvals: recipe.approvals }),
					...(recipe.maxParallelCalls === undefined
						? {}
						: { maxParallelCalls: recipe.maxParallelCalls }),
				};

	/**
	 * One run, driven to its end on the fake clock. A scenario may use a slow tool or a
	 * delay, so time is moved rather than waited.
	 */
	const runOnce = async (
		runId: string,
		turns: readonly ScriptedTurn[],
		resume: { lines: readonly string[]; by: "person"; followUp?: string } | undefined,
	): Promise<RunResult> => {
		const running = runTask({
			runId,
			task: recipe?.name ?? scenario.task,
			host: "scenario",
			input: recipe === undefined && typeof scenario.input === "string" ? scenario.input : "",
			// The file's own compaction and cap first, so a recipe's settings win where it
			// declares them: the file is a file about the host's run, and the host's run is
			// the recipe.
			...(scenario.compaction === undefined
				? {}
				: { compaction: scenario.compaction.settings }),
			...(scenario.maxParallelCalls === undefined
				? {}
				: { maxParallelCalls: scenario.maxParallelCalls }),
			...recipeParts,
			...(resume === undefined ? {} : { resume }),
			system: recipe?.instructions ?? scenario.system,
			tools,
			model: modelFor(turns, scenario.compaction, clock, options),
			storage,
			clock,
			ids,
			// A scenario runs as a host where a person is reachable, so an `ask` policy
			// parks the run rather than being denied (decision 35).
			canAsk: true,
			toolDeadlineMs: 60_000,
			signal: controller.signal,
			onEvent: (event) => {
				events.push(event);
				if (scenario.abortAfter !== undefined && events.length === scenario.abortAfter) {
					controller.abort();
				}
			},
		});

		let settled = false;
		void running.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);
		for (let tick = 0; tick < 200 && !settled; tick += 1) {
			await Promise.resolve();
			clock.advance(1_000);
			await Promise.resolve();
		}
		return running;
	};

	const problems: string[] = [];
	const results: RunResult[] = [];
	/** How many assistant messages the conversation already holds, which is the position the scripted model reads. */
	const answeredSoFar = async (): Promise<{ count: number } | { problem: string }> => {
		// A record that cannot be read would make the padding wrong, and the next step
		// would then consume the wrong turns: a model-script mismatch rather than the
		// cause, so it is reported as the cause.
		const saved = await storage.read();
		if (!saved.ok) {
			return { problem: `the record could not be read: ${saved.error.message}` };
		}
		const record = loadRecord(saved.value);
		if (!record.ok) {
			return { problem: `the record did not load: ${record.error.message}` };
		}
		return {
			count: replayConversation(record.value.entries).filter(
				(message) => message.role === "assistant",
			).length,
		};
	};
	// A file with no `runs:` is one run, exactly as it always was.
	const steps: readonly ScenarioRun[] = scenario.runs ?? [{ model: scenario.model }];
	// One session owns one record and therefore one run id: a follow-up continues that
	// run as a new segment, which is what the record's header and the runtime's resume
	// check allow (decision 44). A step is a segment, not a run of its own.
	const runId = "scenario";

	for (const [index, step] of steps.entries()) {
		const first = index === 0;
		if (!first) {
			const previous = results.at(-1);
			// A run waiting for a person is the session's `busy` rather than a run that
			// can be followed up (CMD08), so the scenario stops with the run named instead
			// of spending the step's turns on a run nobody started.
			if (step.answer === undefined && previous?.parkedReason === "waiting_for_person") {
				problems.push(
					`the run is waiting_for_person after scenario.runs[${index - 1}], so scenario.runs[${index}] cannot start a new segment: answer it first`,
				);
				break;
			}
			if (step.answer !== undefined) {
				const saved = await storage.read();
				const record = saved.ok ? loadRecord(saved.value) : undefined;
				if (record === undefined || !record.ok) {
					problems.push(`scenario.runs[${index}].answer: the record could not be read`);
					break;
				}
				const request = outstandingRequest(record.value);
				if (request === undefined) {
					problems.push(
						`scenario.runs[${index}].answer answers a request, but no run is waiting for one`,
					);
					break;
				}
				const answered = await answerRequest(storage, ids, clock, request, step.answer);
				if (answered !== undefined) {
					problems.push(`scenario.runs[${index}].answer: ${answered}`);
					break;
				}
			}
		}

		const resume = first
			? undefined
			: {
					lines: storage.saved(),
					by: "person" as const,
					...(step.followUp === undefined ? {} : { followUp: step.followUp }),
				};
		// The scripted model answers by the position the turn would have in the
		// conversation, so a resumed run's script starts after the turns the record
		// already holds: a file says what happens next, not what happened before.
		// The padding exists for the conversation-position model, which picks its reply by
		// how much of the conversation is already written. A file that declares
		// compaction is scripted by sequence instead, and each segment's model starts at
		// its own turn 0, so padding there would be served as the segment's replies and
		// the step would have to be nudged before it read its own script (found in review
		// on pull request #78).
		const positioned = scenario.compaction === undefined;
		const alreadyAnswered = first || !positioned ? { count: 0 } : await answeredSoFar();
		if ("problem" in alreadyAnswered) {
			problems.push(`scenario.runs[${index}]: ${alreadyAnswered.problem}`);
			break;
		}
		const turns = [...Array<ScriptedTurn>(alreadyAnswered.count).fill({}), ...step.model];
		results.push(await runOnce(runId, turns, resume));
	}

	const last = results.at(-1);
	if (last === undefined) {
		// The decoder refuses a file with no run, so this is a runner bug rather than a
		// file's mistake, and it says so instead of reporting a scenario that passed
		// without running anything.
		throw new Error(`the scenario ${scenario.name} carries no run to make`);
	}

	const saved = await storage.read();
	if (!saved.ok) {
		return {
			result: last,
			results,
			events,
			problems: [`the record could not be read: ${saved.error.message}`],
		};
	}
	const loaded = loadRecord(saved.value);
	if (!loaded.ok) {
		return {
			result: last,
			results,
			events,
			problems: [`the record did not load: ${loaded.error.message}`],
		};
	}

	for (const note of loaded.value.notes) {
		problems.push(`the record needed a note at line ${note.line}: ${note.problem}`);
	}
	matchScenarioEvents(scenario.expectEvents, events, problems);
	matchScenarioRecord(scenario.expectRecord, loaded.value, problems);
	// A scenario that expected a reason and got another is already caught above, but
	// the run's own ending is worth stating when it is unexpected.
	if (problems.length > 0) {
		problems.push(
			`the run ended ${last.reason}${last.parkedReason === undefined ? "" : ` (${last.parkedReason})`} after ${last.turns} turn(s); last event: ${describeEvent(events.at(-1))}`,
		);
	}
	return { result: last, results, events, record: loaded.value, problems };
}

/** Write the person's answer into the record, the way a session writes one. */
async function answerRequest(
	storage: MemoryStorage,
	ids: Ids,
	clock: FakeClock,
	request: OutstandingRequest,
	answer: ScenarioAnswer,
): Promise<string | undefined> {
	if (answer.decision === undefined && answer.text === undefined) {
		// The decoder refuses this, so only a hand-built Scenario reaches here, and a
		// decision nobody asked for would be worse than saying the answer is empty.
		return "the answer carries neither a decision nor a text";
	}
	const entry: Record<string, unknown> = {
		type: "request_answered",
		id: ids.next("e"),
		parent: request.parent,
		ts: clock.now(),
		request: request.id,
		decision: answer.decision ?? "approve",
	};
	if (answer.note !== undefined) {
		entry["note"] = answer.note;
	}
	if (answer.text !== undefined) {
		entry["text"] = answer.text;
	}
	const saved = await storage.append(JSON.stringify(entry));
	return saved.ok ? undefined : `the answer could not be saved: ${saved.error.message}`;
}
