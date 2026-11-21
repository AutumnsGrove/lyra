/**
 * A model that is wrong on purpose, from a seed (docs/engineering-practices.md,
 * KIT12 and KIT13; decision 64).
 *
 * The scripted model says what a well-behaved provider does. This one says what
 * a real one sometimes does instead: half-written arguments, a tool nobody has,
 * the same call again, an empty answer, a reply cut off by the token limit, and
 * usage with no cost. The run in front of it must still end exactly once with a
 * record that loads, whatever it is given, and the seed is what makes a failure
 * repeatable.
 *
 * One script is drawn per seed, so the same seed produces the same run. The
 * generator assumes the run has a `finish` tool, because that is how a run ends
 * well; a run without one parks, which is still a correct ending.
 */

import type { Clock } from "../core/clock.js";
import type { ModelSlot } from "../core/model.js";
import { scriptedModel, type ScriptedTurn } from "./model.js";

/** The wrong replies this can send, named so a test can say what it got. */
export const MISBEHAVING_KINDS = [
	"done",
	"truncated",
	"unknown",
	"repeat",
	"empty",
	"cut-off",
	"no-cost",
] as const;

export type MisbehavingKind = (typeof MISBEHAVING_KINDS)[number];

export interface MisbehavingTurn {
	turn: MisbehavingKind;
	script: ScriptedTurn;
}

export interface MisbehavingScriptOptions {
	/** How many turns to draw. A run with a step limit needs no more than that. */
	turns?: number;
}

/** A small deterministic generator: the same seed gives the same numbers. */
function draw(seed: number, index: number): number {
	let x = (seed * 2_654_435_761 + index * 40_503 + 1) >>> 0;
	x ^= x << 13;
	x >>>= 0;
	x ^= x >>> 17;
	x ^= x << 5;
	x >>>= 0;
	return x / 0x1_0000_0000;
}

/** How often each wrong reply comes up, out of 100. */
const WEIGHTS: readonly [MisbehavingKind, number][] = [
	["done", 22],
	["truncated", 16],
	["unknown", 14],
	["repeat", 10],
	["empty", 10],
	["cut-off", 12],
	["no-cost", 16],
];

function kindFor(seed: number, index: number): MisbehavingKind {
	const roll = draw(seed, index) * 100;
	let seen = 0;
	for (const [kind, weight] of WEIGHTS) {
		seen += weight;
		if (roll < seen) {
			return kind;
		}
	}
	return "done";
}

export function misbehavingScript(
	seed: number,
	options: MisbehavingScriptOptions = {},
): MisbehavingTurn[] {
	const count = options.turns ?? 16;
	const turns: MisbehavingTurn[] = [];
	for (let index = 0; index < count; index += 1) {
		const kind = kindFor(seed, index);
		const id = `call_${seed}_${index}`;
		const previous = turns.at(-1);
		switch (kind) {
			case "done":
				turns.push({
					turn: kind,
					script: { toolCalls: [{ id, name: "finish", args: {} }] },
				});
				break;
			case "truncated":
				// Half-written JSON, which is what a reply cut off mid-token looks like.
				turns.push({
					turn: kind,
					script: { toolCalls: [{ id, name: "finish", args: '{"done":' }] },
				});
				break;
			case "unknown":
				turns.push({
					turn: kind,
					script: { toolCalls: [{ id, name: "not_a_tool", args: {} }] },
				});
				break;
			case "repeat": {
				// The same call again, which the stuck safeguard is there to notice.
				const repeated = previous?.script.toolCalls?.[0];
				turns.push({
					turn: kind,
					script: {
						toolCalls: [
							repeated === undefined
								? { id, name: "not_a_tool", args: {} }
								: { id, name: repeated.name, args: repeated.args },
						],
					},
				});
				break;
			}
			case "empty":
				turns.push({ turn: kind, script: { text: "" } });
				break;
			case "cut-off":
				turns.push({
					turn: kind,
					script: {
						toolCalls: [{ id, name: "finish", args: {} }],
						finishReason: "length",
					},
				});
				break;
			case "no-cost":
				turns.push({
					turn: kind,
					script: {
						text: "I am not sure what to do next",
						usage: { inputTokens: 40, outputTokens: 6 },
					},
				});
				break;
		}
	}
	return turns;
}

export interface MisbehavingModel extends ModelSlot {
	readonly seed: number;
	/** What each turn was drawn as, in order. */
	readonly turns: readonly MisbehavingKind[];
}

export function misbehavingModel(
	seed: number,
	options: { clock: Clock; turns?: number },
): MisbehavingModel {
	const script = misbehavingScript(
		seed,
		options.turns === undefined ? {} : { turns: options.turns },
	);
	const model = scriptedModel(
		script.map((entry) => entry.script),
		{ clock: options.clock, model: `misbehaving/seed-${seed}` },
	);
	return {
		seed,
		turns: script.map((entry) => entry.turn),
		complete: (request) => model.complete(request),
	};
}
