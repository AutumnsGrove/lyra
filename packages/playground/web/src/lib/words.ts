/**
 * The page's wording for what the protocol reports (issue #102).
 *
 * The protocol speaks in codes (`waiting_for_person`, `model_unavailable`) because a
 * client needs something stable to match on. A person reading the status area needs
 * the same fact in their own words, so the translation lives here, in plain TypeScript
 * the Node suite can test, and the component only draws what this returns.
 */
import type { Status } from "./playground.js";
import type { CapState } from "./sessions.js";

/** How loudly the status area should say it: drives colour, never the text itself. */
export type Tone = "quiet" | "busy" | "ok" | "attention" | "bad";

export interface StatusWords {
	tone: Tone;
	label: string;
	/** The second line: what it is waiting for, why it failed, how long it took. */
	hint: string;
}

/** Codes the protocol is known to send, in a person's words. Anything else is humanised. */
const KNOWN: Record<string, string> = {
	waiting_for_person: "a question or approval is waiting on the page",
	model_unavailable: "the model did not answer",
};

const humanise = (code: string): string => KNOWN[code] ?? code.replaceAll("_", " ");

const plural = (n: number, noun: string): string => `${n} ${noun}${n === 1 ? "" : "s"}`;

export function statusWords(status: Status): StatusWords {
	const facts: string[] = [];
	if (status.turns !== undefined) {
		facts.push(plural(status.turns, "turn"));
	}
	if (status.costUsd !== undefined) {
		facts.push(`$${status.costUsd}`);
	}
	const detail = status.detail === undefined ? undefined : humanise(status.detail);
	const why = detail === undefined ? [] : [detail];

	switch (status.state) {
		case "running":
			return { tone: "busy", label: "Working", hint: facts.join(" · ") };
		case "done":
			return { tone: "ok", label: "Done", hint: [...why, ...facts].join(" · ") };
		case "parked":
			return {
				tone: "attention",
				label: status.detail === "waiting_for_person" ? "Waiting for you" : "Paused",
				hint: [...why, ...facts].join(" · "),
			};
		case "failed":
			return { tone: "bad", label: "Stopped", hint: [...why, ...facts].join(" · ") };
		case "idle":
			return { tone: "quiet", label: "Ready", hint: "" };
	}
}

export interface CapLine {
	text: string;
	/** 0 to 1, for a meter. */
	fraction: number;
	/** True when no new run can start: the cap is reached, or the day is unpriced. */
	over: boolean;
}

/** The day's spend as a sentence and a meter, or nothing when there is no cap to measure against. */
export function capLine(cap: CapState): CapLine | undefined {
	if (cap.cap === null) {
		return undefined;
	}
	if (cap.unpriced) {
		return {
			text: "A reply reported no cost, so no new run starts until UTC midnight",
			fraction: 1,
			over: true,
		};
	}
	const fraction = cap.cap === 0 ? 1 : Math.min(1, Math.max(0, cap.usd / cap.cap));
	return {
		text: `spend $${cap.usd.toFixed(4)} of $${cap.cap.toFixed(2)} today (UTC)`,
		fraction,
		over: cap.usd >= cap.cap,
	};
}
