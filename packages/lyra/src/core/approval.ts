/**
 * What a tool may do without a person, and how a run asks (docs/approvals.md,
 * decisions 34, 35 and 85).
 *
 * One mechanism covers both an approval of a risky call and a question only a
 * person can answer: the run saves a request in the record and parks, and the
 * answer decides what happens next. This module is the part that is a pure
 * decision — which policy governs one call — so the loop and the tests agree on
 * one rule rather than each reading the fields for itself.
 */

import type { Tool, ToolOutcome } from "./tool.js";

/** The three answers a recipe can give for a call (decision 35). */
export type ToolPolicy = "allow" | "ask" | "deny";

/** What a tool does to the world, which sets its default policy (decision 35). */
export type ToolRisk = "reads" | "changes" | "dangerous";

export const TOOL_POLICIES: readonly ToolPolicy[] = ["allow", "ask", "deny"];
export const TOOL_RISKS: readonly ToolRisk[] = ["reads", "changes", "dangerous"];

export function isToolPolicy(value: unknown): value is ToolPolicy {
	return TOOL_POLICIES.some((known) => known === value);
}

export function isToolRisk(value: unknown): value is ToolRisk {
	return TOOL_RISKS.some((known) => known === value);
}

/** How a risk label shapes the default: a change or a danger asks, a read does not. */
export function policyFromRisk(risk: ToolRisk | undefined): ToolPolicy | undefined {
	return risk === "changes" || risk === "dangerous" ? "ask" : undefined;
}

/**
 * The policy that governs one call.
 *
 * The tool's own word wins, then its risk label, then the recipe's default, and a
 * tool that says nothing is allowed. That last rule is deliberate: every tool built
 * before this slice is silent, and silence meaning "ask" would stop every existing
 * recipe at its first call. A caller who wants asking says so (decision 135's
 * sibling, recorded with this slice).
 */
export function policyOf(tool: Tool, recipeDefault: ToolPolicy | undefined): ToolPolicy {
	return tool.policy ?? policyFromRisk(tool.risk) ?? recipeDefault ?? "allow";
}

/** What the model reads when a call was not run, and why. */
export function deniedOutcome(reason: string): ToolOutcome {
	return { isError: true, content: `this call was denied and did not run: ${reason}` };
}

/** The reason a denied call gives, which names the tool so a model can adapt. */
export function deniedByRecipe(tool: Tool): string {
	return `the recipe does not allow the ${tool.spec.name} tool, so nothing ran`;
}

/** The reason a call that needed a person gives when there is nobody to ask. */
export function deniedWithoutAPerson(tool: Tool): string {
	return `the ${tool.spec.name} tool needs a person's approval and nothing can deliver the question, so nothing ran`;
}
