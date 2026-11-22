import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { parse } from "yaml";

import { loadRecord } from "../../record/load.js";
import {
	decodeScenario,
	matchScenarioEvents,
	matchScenarioRecord,
} from "../../testkit/scenario.js";
import type { TestSession } from "./testing/session-class.testing.js";

/**
 * Every scenario file in `scenarios/`, run a third time — over a WebSocket
 * (docs/engineering-practices.md, SCN05's sibling for step 8). The levels are the
 * in-process runner, the fake server, HTTP and now the socket, and a failure here
 * names the level.
 *
 * The file runs in `vitest.ws.config.ts`, because WebSockets under Durable Objects
 * need one worker with isolation off (decision 101), so each scenario gets its own
 * session id and nothing assumes an empty record.
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
	event: { type: string } & Record<string, unknown>;
}

test("every scenario file in the repository is picked up over a socket", () => {
	expect(Object.keys(files).length).toBeGreaterThanOrEqual(6);
});

/** One socket, through its hello exchange, following the session from the start. */
async function socketTo(session: string): Promise<WebSocket> {
	const stub = env.SESSION.get(env.SESSION.idFromString(session));
	const response = await stub.fetch(
		new Request(`https://lyra.test/v1/ws?session=${session}&since=0`, {
			headers: { upgrade: "websocket", authorization: `Bearer ${TOKENS.acme}` },
		}),
	);
	const socket = response.webSocket;
	if (response.status !== 101 || socket === null) {
		throw new Error(`the upgrade was refused with ${response.status}`);
	}
	socket.accept();
	await new Promise<void>((resolve) => {
		socket.addEventListener("message", () => resolve(), { once: true });
	});
	socket.send(
		JSON.stringify({ type: "hello", version: "1", client: "scenario", capabilities: [] }),
	);
	return socket;
}

for (const [path, raw] of Object.entries(files)) {
	const name = nameOf(path);

	test(`SCN05 the scenario ${name} runs over a socket`, async () => {
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

		const socket = await socketTo(session);
		const frames: Frame[] = [];
		let end: () => void = () => undefined;
		const ended = new Promise<void>((resolve) => {
			end = resolve;
		});
		socket.addEventListener("message", (message) => {
			const frame = JSON.parse(String(message.data)) as Record<string, unknown>;
			if (frame["type"] !== "event") {
				return;
			}
			const event = frame["event"] as Frame["event"];
			frames.push({ id: typeof event["seq"] === "number" ? event.seq : null, event });
			if (scenario.abortAfter !== undefined && frames.length === scenario.abortAfter) {
				socket.send(
					JSON.stringify({
						type: "command",
						id: "abort-1",
						command: "abort",
						session,
					}),
				);
			}
			if (event.type === "run_end") {
				end();
			}
		});

		socket.send(
			JSON.stringify({
				type: "command",
				id: "c1",
				command: "start",
				session,
				task: scenario.recipe ?? scenario.task,
				input: scenario.input,
			}),
		);

		// Time is moved rather than waited for, so a slow tool finishes.
		let finished = false;
		void ended.then(() => {
			finished = true;
		});
		for (let tick = 0; tick < 400 && !finished; tick += 1) {
			await runInDurableObject(stub, (instance: TestSession) => {
				instance.advance(1_000);
			});
			await Promise.resolve();
		}
		socket.close();

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
