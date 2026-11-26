/**
 * The first recipe whose tools do something (issue #60, slice 2).
 *
 * `tool-table` is the acceptance list's smallest useful shape: a read of the run's own
 * clock and an arithmetic tool, both of which change nothing, so both are `allow` and
 * both opt into running beside another call (decision 154). Slice 5 fills out the rest
 * of #60's table; this one exists so a person can watch Lyra call a tool against a real
 * model on a real deployment.
 *
 * `now` reads a clock the playground passes in, rather than the host's own time, because
 * a tool cannot see the run's clock through its context: that is what lets a test pin
 * the answer and a replay show the same time the record holds.
 */

import {
	createFinishTool,
	defineTool,
	type Clock,
	type Recipe,
	type Tool,
	type ToolOutcome,
} from "@autumnsgrove/lyra";

const NOW_PARAMETERS = { type: "object", properties: {} } as const;

const CALCULATOR_PARAMETERS = {
	type: "object",
	properties: {
		a: { type: "number" },
		b: { type: "number" },
		op: { type: "string", enum: ["+", "-", "*", "/"] },
	},
	required: ["a", "b", "op"],
} as const;

/** The run's clock, as an ISO string and as milliseconds, so the model can use either. */
export function nowTool(clock: Clock): Tool {
	return defineTool({
		name: "now",
		description:
			"The current time in UTC, as an ISO 8601 string and as milliseconds since the epoch.",
		parameters: NOW_PARAMETERS,
		// Reads the clock and changes nothing, so repeating it after a kill is harmless
		// and it can run beside another read.
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (): Promise<ToolOutcome> => {
			const ms = clock.now();
			return {
				isError: false,
				content: new Date(ms).toISOString(),
				details: { iso: new Date(ms).toISOString(), ms },
			};
		},
	});
}

/** What the calculator refuses, said so the model can correct it rather than retry blind. */
function result(values: { a: number; b: number; op: string }): ToolOutcome {
	const { a, b, op } = values;
	let answer: number;
	switch (op) {
		case "+":
			answer = a + b;
			break;
		case "-":
			answer = a - b;
			break;
		case "*":
			answer = a * b;
			break;
		case "/":
			if (b === 0) {
				return {
					isError: true,
					content: "a division by zero has no answer; use a non-zero divisor",
				};
			}
			answer = a / b;
			break;
		default:
			// The schema refuses this first, so a hand-built call is what reaches here.
			return { isError: true, content: `"${op}" is not one of + - * /` };
	}
	if (!Number.isFinite(answer)) {
		return {
			isError: true,
			content:
				"that result is not a finite number, so it cannot be written down; use smaller numbers",
		};
	}
	return { isError: false, content: String(answer), details: { a, b, op, answer } };
}

export function calculatorTool(): Tool {
	return defineTool({
		name: "calculator",
		description: "Add, subtract, multiply or divide two numbers.",
		parameters: CALCULATOR_PARAMETERS,
		safeToRepeat: true,
		policy: "allow",
		parallel: true,
		execute: async (args): Promise<ToolOutcome> => result(args),
	});
}

/**
 * The recipe the page starts.
 *
 * A plain `Recipe` rather than `defineRecipe`, like the shell: there is no input to check
 * and no state to build, so the ceremony would add a schema nobody reads.
 */
export function toolTableRecipe(options: { clock: Clock }): Recipe {
	return {
		name: "tool-table",
		version: 1,
		instructions: [
			"You are Lyra, running in her playground, and you have a small table of tools.",
			"Use `now` for the time and `calculator` for arithmetic rather than working either out yourself.",
			"Call `finish` when the question is answered.",
		].join(" "),
		tools: [
			nowTool(options.clock),
			calculatorTool(),
			// Nothing to refuse: this recipe has no work whose coverage could be checked,
			// so the done-check is the model's own word and the loop still requires it.
			createFinishTool({ check: () => ({ ok: true }) }),
		],
	};
}
