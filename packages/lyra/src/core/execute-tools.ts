/**
 * Running one reply's tool calls, in order (docs/core-loop.md, LOOP02 and LOOP09).
 *
 * Everything a model can get wrong arrives here: arguments that are not JSON,
 * a tool that does not exist, the same call id twice, a tool that throws, and one
 * that never finishes. Each becomes an error result the model reads and corrects
 * (decision 21), never a crash, and every call in the batch gets an answer so the
 * record stays paired.
 *
 * A call runs under a deadline measured by the injected clock, and its own abort
 * signal fires on that deadline or when the run stops, so a tool that waits can
 * stop waiting.
 *
 * Calls may run beside each other when the batch says how many at once (decision
 * 154). Their results are still awaited and saved in call order, so the record is
 * the one a sequential run of the same calls would have saved, and a group that
 * raises a question saves its siblings either side of the question rather than
 * throwing them away.
 */

import { policyOf, type ToolPolicy } from "./approval.js";
import type { Clock } from "./clock.js";
import { isPlainObject } from "./json.js";
import { isPositiveInteger } from "./limits.js";
import { formatErrors } from "./schema.js";
import type { ToolCall } from "./model.js";
import type { PersonQuestion } from "./tool.js";
import { type Tool, type ToolOutcome } from "./tool.js";

export interface ExecuteToolsOptions {
	calls: readonly ToolCall[];
	tools: readonly Tool[];
	clock: Clock;
	signal: AbortSignal;
	/** How long one call may take, measured on the clock. */
	deadlineMs: number;
	runId: string;
	/** Called for a call that is about to run, after its arguments are known to be usable. */
	onStart(call: ToolCall): void;
	/**
	 * Called for every call, in order, when its result is ready to be saved. A call
	 * that ran carries the arguments it ran with, which is what `apply` needs.
	 */
	onFinish(call: ToolCall, outcome: ToolOutcome, args?: unknown): Promise<void>;
	/**
	 * Called instead of `onFinish` when a tool needs a person before it can answer
	 * (decision 34). The run saves the question and parks, and the answer becomes
	 * this call's result on the resume.
	 */
	onAsk?(call: ToolCall, ask: PersonQuestion): Promise<void>;
	/** The recipe's state, read at the moment a call runs (not copied, not changed). */
	readState?(): unknown;
	/** True once the run has already finished, so later calls are answered but not run. */
	isFinished(): boolean;
	/**
	 * How many of these calls may run at the same time (decision 154). Absent or 1
	 * runs them one after another, which is what a batch that is not a group gets,
	 * and a group larger than this runs in chunks of this size, in call order.
	 *
	 * The caller decides who may run together (`canRunTogether`); this executor does
	 * not re-check each tool, because eligibility depends on the recipe's default
	 * policy, and the scheduler is what knows it.
	 */
	concurrency?: number;
}

/**
 * Whether one call may run beside the others of its reply (decision 154).
 *
 * A tool has to ask for it, and only a tool that changes nothing may have it: a
 * group's calls all read one state, and `apply` is that state's only writer. A
 * tool whose policy asks a person is a barrier too, because the batch stops there
 * and the calls behind it wait for the answer (decision 34).
 */
export function canRunTogether(tool: Tool, recipeDefault: ToolPolicy | undefined): boolean {
	return (
		tool.parallel === true &&
		tool.apply === undefined &&
		policyOf(tool, recipeDefault) === "allow"
	);
}

/** A model's arguments, or the reason they cannot be used. */
export function decodeArguments(
	raw: string,
): { ok: true; value: unknown } | { ok: false; reason: string } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return { ok: false, reason: "its arguments are not valid JSON" };
	}
	if (!isPlainObject(parsed)) {
		// `null`, a list and a bare value are all valid JSON and all wrong here.
		return { ok: false, reason: "its arguments are not a JSON object" };
	}
	return { ok: true, value: parsed };
}

function errorResult(content: string): ToolOutcome {
	return { isError: true, content };
}

/** What a second call that needs a person is told while one question is open. */
const ALREADY_ASKING =
	"the run is already waiting for a person about another call, so this one was not asked about";

export type UsableArguments =
	{ ok: true; value: unknown } | { ok: false; reason: string; invalid: boolean };

/**
 * The arguments a tool may run with: JSON, and the tool's own schema's word.
 *
 * It is one function because the live path and the replay path have to agree, and
 * two copies of "is this call usable" would drift the moment one changed.
 */
export function usableArguments(tool: Tool, raw: string): UsableArguments {
	const decoded = decodeArguments(raw);
	if (!decoded.ok) {
		return { ok: false, reason: decoded.reason, invalid: false };
	}
	if (tool.validate === undefined) {
		return { ok: true, value: decoded.value };
	}
	const checked = tool.validate(decoded.value);
	if (!checked.ok) {
		return { ok: false, reason: formatErrors(checked.errors), invalid: true };
	}
	return { ok: true, value: checked.value };
}

/** A call checked before anything starts: it has an answer, or it will run. */
interface PreparedCall {
	call: ToolCall;
	/** The answer for a call that cannot run, decided before anything runs. */
	answer?: ToolOutcome;
	/** What the call runs with, when it runs. */
	run?: { tool: Tool; args: unknown };
	/** The outcome, once it has been started. */
	outcome?: Promise<ToolOutcome>;
}

/** The arguments a call runs with, and the tool it runs, or the answer it gets instead. */
function prepareCall(
	call: ToolCall,
	byName: ReadonlyMap<string, Tool>,
	available: string,
	options: ExecuteToolsOptions,
): PreparedCall {
	// The calls arrive with unique, non-empty ids: the loop gives the model's
	// unusable ones a name before anything is written (`normalizeCalls`).
	if (options.isFinished()) {
		return { call, answer: errorResult("the run already finished, so this call was not run") };
	}
	if (options.signal.aborted) {
		// A stopped run does not start more work, but every call still gets an
		// answer, so the record stays paired (LOOP06).
		return { call, answer: errorResult("the run was stopped before this call ran") };
	}
	if (call.name === "") {
		return {
			call,
			answer: errorResult(
				`a tool call with no name was not run; ${available === "" ? "no tools are available" : `the tools are ${available}`}`,
			),
		};
	}
	const tool = byName.get(call.name);
	if (tool === undefined) {
		return {
			call,
			answer: errorResult(
				`there is no tool called "${call.name.slice(0, 60)}"; ${names(available)}`,
			),
		};
	}
	// A tool's own schema is the boundary its arguments cross (decision 21). A
	// refused call never reaches the tool, and the model gets the specific message
	// it needs to correct itself (TOL02).
	const args = usableArguments(tool, call.arguments);
	if (!args.ok) {
		return {
			call,
			answer: {
				isError: true,
				content: `the call to ${call.name} was not run because ${args.reason}`,
				...(args.invalid ? { details: { code: "bad_request" } } : {}),
			},
		};
	}
	return { call, run: { tool, args: args.value } };
}

function names(available: string): string {
	return available === "" ? "no tools are available" : `the tools are ${available}`;
}

/**
 * How many calls run at once: a batch that says nothing, or says one, runs them one
 * after another. The cap itself is a positive whole number, which `isPositiveInteger`
 * is the one statement of; "more than one" is this function's own business, because a
 * chunk of one is the serial path.
 */
function usableConcurrency(value: number | undefined): number {
	return isPositiveInteger(value) && value > 1 ? value : 1;
}

export async function executeTools(options: ExecuteToolsOptions): Promise<void> {
	const byName = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
	const available = [...byName.keys()].join(", ");
	const concurrency = usableConcurrency(options.concurrency);

	for (let index = 0; index < options.calls.length; index += concurrency) {
		const asked = await runChunk(
			options.calls.slice(index, index + concurrency),
			byName,
			available,
			options,
		);
		if (asked) {
			// The batch stopped at a question, so the calls behind it have no result
			// yet and are answered when a person does (decision 34).
			return;
		}
	}
}

/**
 * One chunk of a batch. Every call that can run is started before any result is
 * saved, and the results are saved in call order, so a chunk that finishes out of
 * order still writes the record a serial run would.
 *
 * Returns whether a call asked a person, which parks the run once the chunk's own
 * results are saved.
 */
async function runChunk(
	chunk: readonly ToolCall[],
	byName: ReadonlyMap<string, Tool>,
	available: string,
	options: ExecuteToolsOptions,
): Promise<boolean> {
	const prepared = chunk.map((call) => prepareCall(call, byName, available, options));

	for (const item of prepared) {
		if (item.run === undefined) {
			continue;
		}
		options.onStart(item.call);
		item.outcome = runOne(item.run.tool, item.run.args, item.call.id, options);
	}

	let asked = false;
	for (const item of prepared) {
		if (item.outcome === undefined) {
			// Nothing ran, so the answer was decided before the chunk started.
			if (item.answer !== undefined) {
				await options.onFinish(item.call, item.answer);
			}
			continue;
		}
		const outcome = await item.outcome;
		// A call in this chunk may have ended the run, and every call was started
		// before any result was saved, so the calls behind it are answered the way a
		// serial batch answers them rather than with a result the run no longer wants
		// (found in review: a `done` tool in a group let its siblings through).
		if (options.isFinished()) {
			await options.onFinish(
				item.call,
				errorResult("the run already finished, so this call was not run"),
			);
			continue;
		}
		if (outcome.ask !== undefined) {
			if (asked) {
				// One batch parks on one question (decision 34): a second would have to
				// overwrite the first, so it is answered rather than left dangling.
				await options.onFinish(item.call, errorResult(ALREADY_ASKING));
				continue;
			}
			// The tool needs a person before it can answer, so this call gets no result
			// yet: the question is saved where it falls in call order, and the calls
			// beside it have already run and are saved around it (decision 154).
			asked = true;
			await options.onAsk?.(item.call, outcome.ask);
			continue;
		}
		await options.onFinish(item.call, outcome, item.run?.args);
	}
	return asked;
}

/**
 * One tool, under its deadline. The result is always an outcome: a throw becomes
 * an error result, and a call that outstays its deadline does too.
 */
async function runOne(
	tool: Tool,
	args: unknown,
	callId: string,
	options: ExecuteToolsOptions,
): Promise<ToolOutcome> {
	const call = new AbortController();
	const onRunAbort = (): void => {
		call.abort();
	};
	options.signal.addEventListener("abort", onRunAbort, { once: true });
	// The stop may have landed between this call being announced and this listener
	// being attached, and a listener added afterwards never fires for it. The
	// scenario file for a stop during a tool found exactly that gap.
	if (options.signal.aborted) {
		call.abort();
	}

	// The sleep is cancelled through the same signal, so a call that finishes
	// first leaves no timer behind (`clock.pending()` is how a test checks).
	const expired: Promise<"expired" | "stopped"> = options.clock
		.sleep(Math.max(0, options.deadlineMs), call.signal)
		.then(
			() => "expired" as const,
			// The sleep is cancelled either by the deadline or by the run stopping.
			() => "stopped" as const,
		);

	const ran = Promise.resolve()
		.then(() =>
			tool.execute(args, {
				signal: call.signal,
				runId: options.runId,
				callId,
				callKey: `${options.runId}:${callId}`,
				state: options.readState?.(),
			}),
		)
		.then(
			(outcome) => ({ kind: "outcome" as const, outcome }),
			(error: unknown) => ({ kind: "threw" as const, error }),
		);

	const first = await Promise.race([expired, ran]);
	call.abort();
	options.signal.removeEventListener("abort", onRunAbort);

	if (first === "expired") {
		return errorResult(
			`${tool.spec.name} ran past its deadline of ${options.deadlineMs}ms and was stopped`,
		);
	}
	if (first === "stopped") {
		return errorResult(
			`${tool.spec.name} was stopped before it finished, so its outcome is unknown`,
		);
	}
	if (first.kind === "threw") {
		// A tool that throws is a tool failure, not a run failure. The message is
		// the tool's own; a stack would be noise for the model.
		const message = first.error instanceof Error ? first.error.message : String(first.error);
		return errorResult(`${tool.spec.name} failed: ${message}`);
	}
	return first.outcome;
}
