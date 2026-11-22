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
import { isJsonValue, isPlainObject, type JsonValue } from "../core/json.js";
import type { CompactionSettings } from "../core/compaction.js";
import { isFinishReason } from "../core/decode-reply.js";
import type { FinishReason } from "../core/model.js";
import { fail, isErrorCode, ok, type Result } from "../core/result.js";
import { runTask, type RunResult } from "../core/run.js";
import type { Tool } from "../core/tool.js";
import { counterIds } from "../adapters/memory/ids.js";
import { memoryStorage } from "../adapters/memory/storage.js";
import { loadRecord, type LoadedRecord } from "../record/load.js";
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
	toolReturning,
	toolReturningError,
	toolTakingTime,
	toolThatThrows,
} from "./tools.js";

export type ScenarioToolBehavior = "ok" | "error" | "throw" | "slow";

export interface ScenarioTool {
	name: string;
	behavior: ScenarioToolBehavior;
	content?: string;
	/** For a `slow` tool: how long it takes on the fake clock. */
	ms?: number;
}

/** An expectation is matched as a subset, so extra fields on the actual value are fine. */
export type Expectation = Record<string, unknown>;

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
	model: ScriptedTurn[];
	expectEvents: Expectation[];
	expectRecord: Expectation[];
	/** Stop the run when the nth event arrives, for the stop scenarios. */
	abortAfter?: number;
	/** How the run compacts, and how its summaries are answered. */
	compaction?: ScenarioCompaction;
}

export interface ScenarioOutcome {
	result: RunResult;
	events: RunEvent[];
	/** Absent when the record could not be read or did not load. */
	record?: LoadedRecord;
	/** What did not match. Empty means the scenario passed. */
	problems: string[];
}

const BEHAVIORS: readonly ScenarioToolBehavior[] = ["ok", "error", "throw", "slow"];
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
	if (recipe.value !== undefined && !RECIPES.has(recipe.value)) {
		return bad(`scenario.recipe must be one of ${[...RECIPES.keys()].join(", ")}`);
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
			tools.push(tool);
		}
	}

	const rawModel = value["model"];
	if (!Array.isArray(rawModel) || rawModel.length === 0) {
		return bad("scenario.model must be a non-empty list of turns");
	}
	const model: ScriptedTurn[] = [];
	for (const [index, raw] of rawModel.entries()) {
		const turn = decodeTurn(raw, `scenario.model[${index}]`);
		if (!turn.ok) {
			return turn;
		}
		model.push(turn.value);
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

	const rawCompaction = value["compaction"];
	if (rawCompaction !== undefined) {
		const compaction = decodeCompaction(rawCompaction);
		if (!compaction.ok) {
			return compaction;
		}
		scenario.compaction = compaction.value;
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
	switch (tool.behavior) {
		case "error":
			return toolReturningError(tool.name, tool.content ?? `${tool.name} says no`);
		case "throw":
			return toolThatThrows(tool.name, tool.content ?? `${tool.name} broke`);
		case "slow":
			return toolTakingTime(tool.name, tool.ms ?? 100, clock);
		case "ok":
			return toolReturning(tool.name, tool.content ?? `${tool.name} says yes`);
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

/** The testkit recipes a scenario may name, by name. */
const RECIPES = new Map([[timelineTestRecipe.name, timelineTestRecipe]]);

export interface ScenarioRunOptions {
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
function modelFor(scenario: Scenario, clock: FakeClock, options: ScenarioRunOptions): ModelSlot {
	const compaction = scenario.compaction;
	const settings: ScriptedModelOptions = { clock };
	if (compaction !== undefined) {
		settings.summaries = compaction.summaries;
		settings.position = "sequence";
	}
	if (options.makeModel === undefined) {
		return scriptedModel(scenario.model, settings);
	}
	return options.makeModel(scenario.model, clock, settings);
}

export async function runScenario(
	scenario: Scenario,
	options: ScenarioRunOptions = {},
): Promise<ScenarioOutcome> {
	const clock = fakeClock();
	const storage = memoryStorage();
	const events: RunEvent[] = [];
	const controller = new AbortController();
	const recipe = scenario.recipe === undefined ? undefined : RECIPES.get(scenario.recipe);
	const tools: Tool[] =
		recipe === undefined
			? [...scenario.tools.map((tool) => makeScenarioTool(tool, clock)), createFinishTool()]
			: [...recipe.tools];

	// A recipe brings its own first message, state and instructions; a plain scenario
	// still sends its input text straight in.
	const recipeParts =
		recipe === undefined
			? {}
			: {
					inputValue: scenario.input,
					...(recipe.setup === undefined ? {} : { setup: recipe.setup }),
				};

	const running = runTask({
		runId: "scenario",
		task: recipe?.name ?? scenario.task,
		host: "scenario",
		input: recipe === undefined && typeof scenario.input === "string" ? scenario.input : "",
		...recipeParts,
		system: recipe?.instructions ?? scenario.system,
		tools,
		model: modelFor(scenario, clock, options),
		storage,
		clock,
		ids: counterIds(),
		...(scenario.compaction === undefined ? {} : { compaction: scenario.compaction.settings }),
		toolDeadlineMs: 60_000,
		signal: controller.signal,
		onEvent: (event) => {
			events.push(event);
			if (scenario.abortAfter !== undefined && events.length === scenario.abortAfter) {
				controller.abort();
			}
		},
	});

	// A scenario may use a slow tool or a delay, so time is moved rather than waited.
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
	const result = await running;

	const saved = await storage.read();
	if (!saved.ok) {
		return {
			result,
			events,
			problems: [`the record could not be read: ${saved.error.message}`],
		};
	}
	const loaded = loadRecord(saved.value);
	if (!loaded.ok) {
		return { result, events, problems: [`the record did not load: ${loaded.error.message}`] };
	}

	const problems: string[] = [];
	for (const note of loaded.value.notes) {
		problems.push(`the record needed a note at line ${note.line}: ${note.problem}`);
	}
	matchScenarioEvents(scenario.expectEvents, events, problems);
	matchScenarioRecord(scenario.expectRecord, loaded.value, problems);
	// A scenario that expected a reason and got another is already caught above, but
	// the run's own ending is worth stating when it is unexpected.
	if (problems.length > 0) {
		problems.push(
			`the run ended ${result.reason}${result.parkedReason === undefined ? "" : ` (${result.parkedReason})`} after ${result.turns} turn(s); last event: ${describeEvent(events.at(-1))}`,
		);
	}
	return { result, events, record: loaded.value, problems };
}
