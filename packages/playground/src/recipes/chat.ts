/**
 * The recipe whose answer is its reply (issue #106).
 *
 * Every other recipe here has a job with a shape to satisfy, so it ends when a done-check
 * passes and a model that falls silent is nudged (decision 25). A conversation has no shape:
 * the writer types, the model answers in a sentence or two, and the reply *is* the
 * deliverable. The only way to end a run like that before this was a sentinel `finish` that a
 * model answers well and then forgets — which parked the conversation, and which Autumn met
 * in this playground as well as in Fireside.
 *
 * So this recipe declares `ending: "reply"` and carries no `finish` at all: the two are
 * refused together where a recipe is defined, because two things would claim to be the ending
 * (decision 163). `now` and `calculator` stay, because a conversation that can look up the
 * time or do the arithmetic is a better demonstration than one that cannot.
 */

import type { Clock, Recipe } from "@autumnsgrove/lyra";

import { calculatorTool, nowTool } from "./tool-table.js";

export interface ChatOptions {
	/** The clock `now` reads, so a test pins the answer rather than the wall's time. */
	clock: Clock;
}

export function chatRecipe(options: ChatOptions): Recipe {
	return {
		name: "chat",
		version: 1,
		instructions: [
			"You are Lyra, running in her playground, and this is a conversation.",
			"Answer the person in your own words, in a sentence or two, and stop there: your reply is the answer, and there is nothing to file and no tool to call to finish.",
			"`now` and `calculator` are there if you need the time or the arithmetic, and using them is your choice rather than a step.",
		].join(" "),
		tools: [nowTool(options.clock), calculatorTool()],
		ending: "reply",
	};
}
