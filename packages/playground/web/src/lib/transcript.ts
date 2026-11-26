/**
 * A conversation rebuilt from its record (issue #60, slice 3).
 *
 * The live path folds events (`reduce`), and a reload has to draw the same thing. It
 * could ask for the event stream from the beginning, and that would be the same
 * projection Lyra does server-side — except that `user_message` is deliberately **not**
 * a protocol event (`packages/lyra/src/protocol/events.ts` says so: the record holds it
 * and the protocol does not), so a transcript rebuilt from events alone would lose every
 * thing the person said.
 *
 * So the page reads the record's entries, which hold both sides, and maps the entry
 * kinds a transcript draws. A kind this page has no rule for is skipped rather than
 * drawn as a hole: a later Lyra writes entries this build never saw.
 */

import { EMPTY_TRANSCRIPT, type Row, type Status, type Transcript } from "./playground.js";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOf(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function numberOf(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** A status entry's state, as the status line's own words. */
function stateOf(state: string | undefined): Status["state"] {
	switch (state) {
		case "done":
			return "done";
		case "parked":
			return "parked";
		case "failed":
			return "failed";
		case "running":
		case "resumed":
			return "running";
		default:
			return "idle";
	}
}

/** What a parked entry says: its reason, and the half of it that names the limit. */
function detailOf(entry: Record<string, unknown>): string | undefined {
	const reason = stringOf(entry["reason"]);
	const detail = stringOf(entry["detail"]);
	if (reason === undefined) {
		return detail;
	}
	return detail === undefined ? reason : `${reason}: ${detail}`;
}

/**
 * The transcript a record holds, in the order it was written.
 *
 * Turns and the run's cost are counted from the assistant entries rather than read from
 * a `run_end`, because a reload has no event to read: the record is what survives.
 */
export function transcriptFrom(entries: readonly Record<string, unknown>[]): Transcript {
	const rows: Row[] = [];
	/** The tools each call id named, so a tool's own entry can say which tool it was. */
	const callNames = new Map<string, string>();
	let status: Status = EMPTY_TRANSCRIPT.status;
	let turns = 0;
	let cost = 0;
	let priced = false;

	for (const entry of entries) {
		if (!isRecord(entry)) {
			continue;
		}
		switch (entry["type"]) {
			case "user_message": {
				const text = stringOf(entry["text"]) ?? "";
				if (text !== "") {
					rows.push({ kind: "person", text });
				}
				break;
			}
			case "assistant_message": {
				turns += 1;
				const usage = entry["usage"];
				if (isRecord(usage) && isRecord(usage["cost"])) {
					const amount = numberOf(usage["cost"]["amount"]);
					if (amount !== undefined) {
						cost += amount;
						priced = true;
					}
				}
				const calls = Array.isArray(entry["toolCalls"]) ? entry["toolCalls"] : [];
				const at = numberOf(entry["ts"]);
				const toolRows: Row[] = [];
				for (const call of calls) {
					if (!isRecord(call)) {
						continue;
					}
					const name = stringOf(call["name"]) ?? "tool";
					const callId = stringOf(call["id"]) ?? "";
					callNames.set(callId, name);
					const args = stringOf(call["arguments"]);
					toolRows.push({
						kind: "tool",
						name,
						callId,
						...(args === undefined ? {} : { arguments: args }),
						// The assistant entry's own time, which is what the tool's entry is
						// measured against: the record's numbers, not the page's clock.
						...(at === undefined ? {} : { at }),
					});
				}
				const text = stringOf(entry["text"]) ?? "";
				const reasoning = stringOf(entry["reasoning"]);
				if (text !== "" || (reasoning !== undefined && reasoning !== "")) {
					rows.push({
						kind: "assistant",
						text,
						...(reasoning === undefined || reasoning === "" ? {} : { reasoning }),
					});
				}
				rows.push(...toolRows);
				break;
			}
			case "tool_message": {
				const callId = stringOf(entry["toolCallId"]) ?? "";
				const endedAt = numberOf(entry["ts"]);
				// The call's row, filled in: a call and its result are the same line, so a
				// group of calls stays one list after a reload as well as during the run.
				let matched = false;
				for (let index = rows.length - 1; index >= 0; index -= 1) {
					const row = rows[index];
					if (
						row === undefined ||
						matched ||
						row.kind !== "tool" ||
						row.callId !== callId
					) {
						continue;
					}
					matched = true;
					const durationMs =
						endedAt === undefined || row.at === undefined
							? undefined
							: endedAt - row.at;
					rows[index] = {
						...row,
						// A tool message names no tool, so the name comes from the call it
						// answers; a record with no such call is drawn under its id.
						name: callNames.get(callId) ?? row.name,
						result: stringOf(entry["content"]) ?? "",
						isError: entry["isError"] === true,
						...(durationMs === undefined ? {} : { durationMs }),
					};
				}
				break;
			}
			case "status": {
				const state = stateOf(stringOf(entry["state"]));
				const detail = detailOf(entry);
				status = { state, ...(detail === undefined ? {} : { detail }) };
				break;
			}
			default:
				// A header, a note, a request, a record kind from a later build: the
				// transcript draws none of them, and none of them is an error.
				break;
		}
	}

	return {
		rows,
		status: {
			...status,
			...(turns === 0 ? {} : { turns }),
			...(priced ? { costUsd: cost } : {}),
		},
	};
}
