import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import type { DurableObjectStub } from "@cloudflare/workers-types";
import { expect, test } from "vitest";
import { parse } from "yaml";

import { loadRecord } from "../../record/load.js";
import {
	decodeScenario,
	matchScenarioEvents,
	matchScenarioRecord,
	outstandingRequestOf,
	type ScenarioAnswer,
	type ScenarioRun,
} from "../../testkit/scenario.js";
import fixture from "./testing/fixture-worker.testing.js";
import type { TestSession } from "./testing/session-class.testing.js";

/**
 * Every scenario file in `scenarios/`, run again over the real HTTP surface
 * (docs/engineering-practices.md, SCN05; step 6's "done when"). The in-process
 * runner in `src/scenarios.test.ts` is the first level and the fake server the
 * second; here the commands and events really travel, through a Durable Object
 * with SQLite storage and its own alarm.
 *
 * A file's scenario is loaded into the object before the run (test support, the
 * way step 4's fixture is configured), and from then on the test only speaks the
 * protocol: `POST /v1/commands`, `GET /v1/events`, `POST /v1/commands` again for
 * an `abort`. A `slow` tool runs on the fake clock, so the test advances it rather
 * than waiting.
 */

const TOKENS = { acme: "tok-acme" };

const files = import.meta.glob<string>("../../../../../scenarios/*.yaml", {
	query: "?raw",
	import: "default",
	eager: true,
});

function nameOf(path: string): string {
	return path.split("/").at(-1) ?? path;
}

interface Frame {
	id: number | null;
	event: { type: string };
}

function auth(token: string): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

async function post(path: string, body: unknown, token: string = TOKENS.acme): Promise<Response> {
	return fixture.fetch(
		new Request(`https://lyra.test${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...auth(token) },
			body: JSON.stringify(body),
		}),
		env,
	);
}

async function get(path: string, lastEventId?: string): Promise<Response> {
	return fixture.fetch(
		new Request(`https://lyra.test${path}`, {
			method: "GET",
			headers: {
				...auth(TOKENS.acme),
				...(lastEventId === undefined ? {} : { "last-event-id": lastEventId }),
			},
		}),
		env,
	);
}

test("every scenario file in the repository is picked up over HTTP", () => {
	expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
});

test("a scenario naming a recipe this workerd harness does not have is refused, not run", async () => {
	// The harness has the testkit's recipe and nothing else, so a file naming a host's
	// recipe must fail where it is configured rather than quietly running the inline
	// branch under that name (found in review).
	const decoded = decodeScenario({
		name: "a host recipe at the wrong level",
		task: "somewhere-else",
		input: {},
		recipe: "somewhere-else",
		model: [{ tool_calls: [{ id: "c1", name: "finish", args: {} }] }],
	});
	if (!decoded.ok) {
		throw new Error(decoded.error.message);
	}
	const stub = env.SESSION.get(env.SESSION.newUniqueId());
	await expect(
		runInDurableObject(stub, (instance: TestSession) => {
			instance.configure(decoded.value);
		}),
	).rejects.toThrow(/only has timeline-test/);
});

for (const [path, raw] of Object.entries(files)) {
	const name = nameOf(path);

	test(`SCN05 the scenario ${name} runs over HTTP`, async () => {
		const decoded = decodeScenario(parse(raw));
		if (!decoded.ok) {
			throw new Error(`${name}: ${decoded.error.message}`);
		}
		const scenario = decoded.value;
		const stub = env.SESSION.get(env.SESSION.newUniqueId());
		const session = stub.id.toString();
		await runInDurableObject(stub, (instance: TestSession) => {
			instance.configure(scenario);
		});

		const started = await post("/v1/commands", {
			type: "command",
			id: "c1",
			command: "start",
			session,
			task: scenario.recipe ?? scenario.task,
			input: scenario.input,
		});
		const answer = (await started.json()) as { ok: boolean; data?: unknown };
		expect(answer.ok).toBe(true);

		// Time is moved rather than waited for, so a slow tool finishes; the abort
		// scenario is the one case where moving it early would change the moment.
		let ended = false;
		const drive =
			scenario.abortAfter === undefined
				? (async () => {
						while (!ended) {
							await runInDurableObject(stub, (instance: TestSession) => {
								instance.advance(1_000);
							});
							await Promise.resolve();
						}
					})()
				: Promise.resolve();

		// A conversation file is several segments of one run, so each later step is a
		// real command on the wire, sent when the segment before it ends: the same door
		// a browser uses, not a shortcut through the object.
		const steps: readonly ScenarioRun[] = scenario.runs ?? [];
		let segment = 1;
		const frames = await readEvents(session, scenario.abortAfter, async () => {
			const next = steps[segment];
			segment += 1;
			if (next === undefined) {
				return false;
			}
			await sendStep(next, session, stub);
			return true;
		});
		ended = true;
		await drive;

		const lines = await runInDurableObject(stub, (instance: TestSession) => instance.lines());
		const loaded = loadRecord(lines);
		const problems: string[] = [];
		expect(loaded.ok ? [] : [loaded.ok ? "" : loaded.error.message]).toEqual([]);
		const record = loaded.ok ? loaded.value : undefined;

		matchScenarioEvents(
			scenario.expectEvents,
			frames.map((frame) => frame.event),
			problems,
		);
		if (record !== undefined) {
			matchScenarioRecord(scenario.expectRecord, record, problems);
		}
		expect(problems).toEqual([]);
	});
}

/** Send one conversation step as the person would: an answer, or a follow-up. */
async function sendStep(
	step: ScenarioRun,
	session: string,
	stub: DurableObjectStub,
): Promise<void> {
	if (step.answer !== undefined) {
		const lines = await runInDurableObject(stub, (instance: TestSession) => instance.lines());
		const loaded = loadRecord(lines);
		if (!loaded.ok) {
			throw new Error(`the record did not load: ${loaded.error.message}`);
		}
		const request = outstandingRequestOf(loaded.value);
		if (request === undefined) {
			throw new Error("the step answers a request, and the record holds none");
		}
		const answered = await post("/v1/ui_response", uiResponse(session, request, step.answer));
		expect(answered.status).toBe(200);
	}
	if (step.followUp !== undefined) {
		const followed = await post("/v1/commands", {
			type: "command",
			id: `follow-${session}`,
			command: "follow_up",
			session,
			text: step.followUp,
		});
		expect(followed.status).toBe(200);
	}
}

function uiResponse(
	session: string,
	request: string,
	answer: ScenarioAnswer,
): Record<string, unknown> {
	return {
		type: "ui_response",
		id: `answer-${request}`,
		session,
		request,
		ok: answer.decision !== "deny",
		...(answer.note === undefined ? {} : { note: answer.note }),
		...(answer.text === undefined ? {} : { text: answer.text }),
	};
}

/**
 * The events of a run as they arrive, aborting when a file says so, until one
 * segment ends. The abort lands on the same event the in-process runner stops at,
 * because the protocol keeps the same order for the events a file names.
 */
async function readEvents(
	session: string,
	abortAfter: number | undefined,
	onSegmentEnd?: () => Promise<boolean>,
): Promise<Frame[]> {
	const response = await get(`/v1/events?session=${session}`, "0");
	expect(response.status).toBe(200);
	const body = response.body;
	if (body === null) {
		throw new Error("the event stream had no body");
	}
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const frames: Frame[] = [];
	let text = "";
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			break;
		}
		text += decoder.decode(chunk.value);
		const blocks = text.split("\n\n");
		text = blocks.pop() ?? "";
		for (const block of blocks) {
			const frame = frameOf(block);
			if (frame === undefined) {
				continue;
			}
			frames.push(frame);
			// The file's index counts in-process events, one of which (`tool_start`) is
			// live-only and may not reach a client that connects a moment late. The
			// turn's end is the same moment on the wire: the tool it called is running.
			if (abortAfter !== undefined && frame.event.type === "turn_end") {
				const aborted = await post("/v1/commands", {
					type: "command",
					id: "c2",
					command: "abort",
					session,
				});
				expect(aborted.status).toBe(200);
			}
			if (frame.event.type === "run_end") {
				// A conversation file is several segments of one run, and the stream stays
				// open across them the way a browser's does: the next command goes out
				// here, and the events of the next segment arrive on the same stream.
				if (onSegmentEnd !== undefined && (await onSegmentEnd())) {
					continue;
				}
				await reader.cancel();
				return frames;
			}
		}
	}
	return frames;
}

function frameOf(block: string): Frame | undefined {
	const lines = block.split("\n");
	const data = lines.find((line) => line.startsWith("data: "));
	if (data === undefined) {
		return undefined;
	}
	const id = lines.find((line) => line.startsWith("id: "));
	return {
		id: id === undefined ? null : Number(id.slice(4)),
		event: JSON.parse(data.slice(6)) as { type: string },
	};
}
