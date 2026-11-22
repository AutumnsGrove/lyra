/**
 * A proposal: a finished run's result, for a person to decide later (decisions 50,
 * 52 and 53).
 *
 * It is the other half of "waiting for a person". An approval pauses a run before
 * an action; a proposal is what a run leaves behind when the decision can be made
 * afterwards, which is how HawkAgent and several other consumers work. The task
 * owns the payload's shape, so a viewer can show any proposal without knowing the
 * task, and the evidence names what supports it.
 */

import { isJsonValue, isPlainObject, type JsonObject, type JsonValue } from "./json.js";
import { compileSchema, formatErrors, validateValue } from "./schema.js";
import type { Tool, ToolOutcome } from "./tool.js";

export interface ProposeToolOptions {
	/** The tool's name. `propose` unless a recipe wants another. */
	name?: string;
	description?: string;
	/** The schema of the payload, which is the task's own shape (decision 52). */
	payload: JsonObject;
}

/**
 * The tool a recipe ends with when its result is a decision someone else makes.
 *
 * Its arguments carry the payload and the evidence, so both are checked where the
 * model's turn crosses into the run rather than trusted: a payload the schema
 * refuses never becomes a proposal, and the model is told what was wrong so it can
 * correct itself (decision 21).
 */
export function createProposeTool(options: ProposeToolOptions): Tool {
	// A payload schema this build cannot compile is a recipe's mistake, and it is
	// thrown where the tool is written rather than at a run's last turn.
	const payload = compileSchema(options.payload, "a proposal's payload");
	const parameters: JsonObject = {
		type: "object",
		properties: {
			payload: options.payload,
			evidence: { type: "array", items: { type: "string" }, minItems: 1 },
		},
		required: ["payload", "evidence"],
	};
	const compiled = compileSchema(parameters, "the propose tool's parameters");

	const tool: Tool = {
		spec: {
			name: options.name ?? "propose",
			description:
				options.description ??
				"Propose a result for a person to decide on, with the evidence that supports it.",
			parameters,
		},
		// The payload has its own check as well, because the tool's parameters only
		// know it is JSON: the recipe's schema is what makes it the task's shape.
		validate: (args) => {
			const checked = validateValue(compiled, args);
			if (!checked.ok) {
				return checked;
			}
			const shape = isPlainObject(checked.value) ? checked.value["payload"] : undefined;
			const payloadCheck = validateValue(payload, shape, "payload");
			return payloadCheck.ok ? checked : payloadCheck;
		},
		async execute(args): Promise<ToolOutcome> {
			// The loop validated these, and a tool called directly is validated again,
			// so this is where the shape stops being the model's word.
			const payloadValue = isPlainObject(args) ? args["payload"] : undefined;
			const evidence = isPlainObject(args) ? args["evidence"] : undefined;
			if (
				!isJsonValue(payloadValue) ||
				!Array.isArray(evidence) ||
				!evidence.every((item) => isJsonValue(item))
			) {
				return {
					isError: true,
					content:
						`a proposal needs a payload and a list of evidence references; ${formatErrors([])}`.trim(),
				};
			}
			return {
				isError: false,
				content: "the proposal was recorded and a person will decide on it",
				propose: { payload: payloadValue, evidence },
			};
		},
	};
	tool.proposes = true;
	return tool;
}
