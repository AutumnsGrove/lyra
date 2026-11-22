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
 */

import type { Clock } from "./clock.js";
import { isPlainObject } from "./json.js";
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

export async function executeTools(options: ExecuteToolsOptions): Promise<void> {
	const byName = new Map(options.tools.map((tool) => [tool.spec.name, tool]));
	const available = [...byName.keys()].join(", ");

	for (const call of options.calls) {
		// The calls arrive with unique, non-empty ids: the loop gives the model's
		// unusable ones a name before anything is written (`normalizeCalls`).
		if (options.isFinished()) {
			await options.onFinish(
				call,
				errorResult("the run already finished, so this call was not run"),
			);
			continue;
		}
		if (options.signal.aborted) {
			// A stopped run does not start more work, but every call still gets an
			// answer, so the record stays paired (LOOP06).
			await options.onFinish(call, errorResult("the run was stopped before this call ran"));
			continue;
		}

		if (call.name === "") {
			await options.onFinish(
				call,
				errorResult(
					`a tool call with no name was not run; ${available === "" ? "no tools are available" : `the tools are ${available}`}`,
				),
			);
			continue;
		}

		const tool = byName.get(call.name);
		if (tool === undefined) {
			const names =
				available === "" ? "no tools are available" : `the tools are ${available}`;
			await options.onFinish(
				call,
				errorResult(`there is no tool called "${call.name.slice(0, 60)}"; ${names}`),
			);
			continue;
		}

		// A tool's own schema is the boundary its arguments cross (decision 21). A
		// refused call never reaches the tool, and the model gets the specific
		// message it needs to correct itself (TOL02).
		const args = usableArguments(tool, call.arguments);
		if (!args.ok) {
			await options.onFinish(call, {
				isError: true,
				content: `the call to ${call.name} was not run because ${args.reason}`,
				...(args.invalid ? { details: { code: "bad_request" } } : {}),
			});
			continue;
		}

		options.onStart(call);
		const outcome = await runOne(tool, args.value, call.id, options);
		if (outcome.ask !== undefined) {
			// The tool needs a person before it can answer, so this call gets no result
			// yet: the question is saved and the run parks (decision 34).
			await options.onAsk?.(call, outcome.ask);
			return;
		}
		await options.onFinish(call, outcome, args.value);
	}
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
