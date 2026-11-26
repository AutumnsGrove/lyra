/**
 * The smoke job (issue #60, slice 7; PGS43 and PGS44).
 *
 * A deployment that is only tested from the inside is a deployment nothing has driven from
 * outside. This drives the live Worker the way a client does: it creates a conversation as
 * the smoke tenant, proves the script boundary refuses what it should, runs a scripted
 * model through the protocol, and asserts the record the run left behind. A scripted run
 * costs nothing, so this can run on every push to `main`.
 *
 * Every failure is a thrown error with the thing that went wrong, so the job log says what
 * broke rather than "assertion failed". No secret is ever printed.
 */

const base = process.env.PLAYGROUND_URL ?? "https://lyra-playground.m7jv4v7npb.workers.dev";
const smokeToken = required("PLAYGROUND_SMOKE_TOKEN");
const scriptToken = required("PLAYGROUND_SCRIPT_TOKEN");
const smokeTenant = process.env.PLAYGROUND_SMOKE_TENANT ?? "smoke";

function required(name) {
	const value = process.env[name];
	if (typeof value !== "string" || value === "") {
		throw new Error(`${name} is not set, so the smoke job cannot run`);
	}
	return value;
}

function check(condition, message) {
	if (!condition) {
		throw new Error(message);
	}
}

async function call(path, init = {}) {
	return fetch(`${base}${path}`, init);
}

/** One command frame, with the smoke bearer and any extra headers. */
async function command(frame, headers = {}) {
	const response = await call("/v1/commands", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-lyra-version": "1",
			authorization: `Bearer ${smokeToken}`,
			...headers,
		},
		body: JSON.stringify(frame),
	});
	const body = await response.json();
	return { status: response.status, body };
}

function startFrame(session, input) {
	return {
		type: "command",
		id: `smoke-start-${Date.now()}`,
		command: "start",
		task: "tool-table",
		input,
		session,
	};
}

/** The script the smoke run answers: one read, then finish. */
const SCRIPT = JSON.stringify([
	{ toolCalls: [{ id: "smoke-1", name: "now", arguments: "{}" }] },
	{ toolCalls: [{ id: "smoke-2", name: "finish", arguments: "{}" }] },
]);

async function main() {
	// 1. A conversation as the smoke tenant. The tenant comes from the bearer, so this also
	// proves the smoke token is bound to its own tenant rather than the person's.
	const created = await call("/api/sessions", {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${smokeToken}` },
		body: JSON.stringify({ recipe: "tool-table", label: `smoke ${new Date().toISOString()}` }),
	});
	check(created.status === 201, `POST /api/sessions answered ${created.status}`);
	const { session } = await created.json();
	check(typeof session === "string" && session !== "", "the created conversation had no session");

	// 2. The boundary: no script, and a wrong token, are both refused and start nothing.
	const headerless = await command(startFrame(session, "this must not run"));
	check(headerless.status === 403, `a headerless start answered ${headerless.status}, not 403`);
	check(
		headerless.body?.error?.code === "permission_denied",
		"a headerless start was not permission_denied",
	);

	const wrongToken = await command(startFrame(session, "this must not run"), {
		"x-lyra-script": SCRIPT,
		"x-lyra-script-token": "not-the-token",
	});
	check(wrongToken.status === 403, `a wrong script token answered ${wrongToken.status}, not 403`);

	// 3. The scripted run itself.
	const started = await command(startFrame(session, "what time is it?"), {
		"x-lyra-script": SCRIPT,
		"x-lyra-script-token": scriptToken,
	});
	check(
		started.status === 200 && started.body?.ok === true,
		`the scripted start answered ${started.status}`,
	);

	// 4. Follow the stream to its end and collect what happened.
	const events = await stream(session, started.body.data.run);
	check(
		events.some(
			(event) => event.type === "tool_end" && event.name === "now" && event.isError === false,
		),
		"the run never answered the scripted now call",
	);
	const end = events.filter((event) => event.type === "run_end").at(-1);
	check(end !== undefined, "the run never ended");
	check(end.reason === "done", `the run ended ${end.reason}, not done`);

	// 5. The record the run left, which is the half a view reads.
	const record = await command({
		type: "command",
		id: "smoke-record",
		command: "get_messages",
		session,
	});
	check(
		record.status === 200 && record.body?.ok === true,
		`get_messages answered ${record.status}`,
	);
	const entries = record.body.data.entries;
	check(Array.isArray(entries) && entries.length > 0, "the record was empty");
	check(
		entries.some((entry) => entry.type === "tool_message" && entry.toolCallId === "smoke-1"),
		"the record has no result for the scripted call",
	);

	console.log(
		`smoke ok: tenant ${smokeTenant}, session ${session}, ${entries.length} entries, run ${end.reason}`,
	);
}

/**
 * Read the event stream until the run ends, or until the timeout.
 *
 * The stream is a fetch, not an `EventSource`, because it takes the bearer in a header; a
 * timeout is the ceiling, and the `run_end` is what ends the read.
 */
async function stream(session, run) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 90_000);
	const events = [];
	try {
		const response = await call(`/v1/events?session=${encodeURIComponent(session)}`, {
			headers: { authorization: `Bearer ${smokeToken}`, accept: "text/event-stream" },
			signal: controller.signal,
		});
		check(
			response.ok && response.body !== null,
			`the event stream answered ${response.status}`,
		);
		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		for (;;) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });
			let boundary = buffer.indexOf("\n\n");
			while (boundary !== -1) {
				const block = buffer.slice(0, boundary);
				buffer = buffer.slice(boundary + 2);
				const data = block
					.split("\n")
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice("data:".length).trimStart())
					.join("\n");
				if (data !== "") {
					try {
						events.push(JSON.parse(data));
					} catch {
						// A block this script cannot read is not a run that ended; keep reading.
					}
				}
				boundary = buffer.indexOf("\n\n");
			}
			if (events.some((event) => event.type === "run_end" && event.run === run)) {
				await reader.cancel().catch(() => undefined);
				break;
			}
		}
		reader.releaseLock();
	} finally {
		clearTimeout(timer);
	}
	return events;
}

main().catch((error) => {
	console.error(`smoke failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
