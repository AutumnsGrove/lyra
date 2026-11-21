#!/usr/bin/env node
/**
 * A developer client for Lyra's HTTP surface (step 6).
 *
 * Plain Node ESM with no dependencies, driving the same commands a page or a
 * script would: `start`, `tail`, `steer`, `follow-up`, `abort`, `resume`,
 * `messages`. It is a developer tool, not a coding TUI. The line reader comes from
 * the built package (`packages/lyra/dist`) rather than a second copy, so the
 * client and the server cannot disagree about what a line is; run `pnpm build`
 * once first.
 *
 * The base URL and token come from `LYRA_URL` and `LYRA_TOKEN`, so nothing secret
 * is ever a command-line argument.
 */

import { lineReader } from "../packages/lyra/dist/protocol/reader.js";

const base = (process.env.LYRA_URL ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const token = process.env.LYRA_TOKEN ?? "dev-token";
let counter = 0;

function usage() {
	const lines = [
		"pnpm lyra <command> [options]",
		"",
		"  start <task> [--input <text>] [--key <key>]   begin a task, and print what it did",
		"  tail <session> [--after <seq>]                watch a session's events until it ends",
		"  steer <session> <text>                        redirect the active run",
		"  follow-up <session> <text>                    say one more thing",
		"  abort <session>                               stop the active run",
		"  resume <session>                              continue a parked run",
		"  messages <session> [--entry <id>]             print the record a page at a time",
		"",
		"LYRA_URL and LYRA_TOKEN say where the server is and who you are.",
	];
	process.stderr.write(`${lines.join("\n")}\n`);
	process.exitCode = 2;
}

function option(args, name) {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
}

function positional(args) {
	return args.filter((arg, index) => !arg.startsWith("--") && !args[index - 1]?.startsWith("--"));
}

async function command(body) {
	counter += 1;
	const response = await fetch(`${base}/v1/commands`, {
		method: "POST",
		headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
		body: JSON.stringify({ type: "command", id: `cli-${counter}`, ...body }),
	});
	const frame = await response.json();
	if (frame.ok === false) {
		process.stderr.write(`${frame.error.code}: ${frame.error.message}\n`);
		process.exitCode = 1;
	}
	return frame;
}

function printData(frame) {
	process.stdout.write(`${JSON.stringify(frame.data ?? {}, null, 2)}\n`);
}

/** The session's events, from `after`, printed as they arrive. */
async function tail(session, after) {
	const headers = { authorization: `Bearer ${token}` };
	if (after !== undefined) {
		headers["last-event-id"] = String(after);
	}
	const response = await fetch(`${base}/v1/events?session=${encodeURIComponent(session)}`, {
		headers,
	});
	if (response.status !== 200 || response.body === null) {
		process.stderr.write(`${response.status}: ${await response.text()}\n`);
		process.exitCode = 1;
		return;
	}
	// One reader for the whole stream: a message can be split across two reads. The
	// reader drops blank lines (a frame never has one), so each `data:` line is one
	// message, which is what this server sends: an event, then a blank line.
	const reader = response.body.getReader();
	const lines = lineReader();
	for (;;) {
		const chunk = await reader.read();
		if (chunk.done) {
			return;
		}
		for (const line of chunk.value === undefined ? [] : lines.push(chunk.value).lines) {
			const frame = parseEvent(line);
			if (frame === undefined) {
				continue;
			}
			const label = frame.seq === undefined ? "     " : String(frame.seq).padStart(4);
			process.stderr.write(`${label} ${frame.type}\n`);
			if (frame.type === "run_end") {
				await reader.cancel();
				return;
			}
		}
	}
}

/** One server-sent-event message's data line as an event, or nothing. */
function parseEvent(line) {
	if (!line.startsWith("data: ")) {
		return undefined;
	}
	try {
		return JSON.parse(line.slice("data: ".length));
	} catch {
		return undefined;
	}
}

async function messages(session, entry) {
	let cursor;
	for (;;) {
		const frame = await command({
			command: "get_messages",
			session,
			...(entry === undefined ? {} : { entry }),
			...(cursor === undefined ? {} : { cursor }),
		});
		if (frame.ok !== true) {
			return;
		}
		for (const record of frame.data.entries) {
			process.stdout.write(
				`${record.type}${record.label === undefined ? "" : ` ${record.label}`}\n`,
			);
		}
		if (frame.data.cursor === null) {
			return;
		}
		cursor = frame.data.cursor;
	}
}

async function main() {
	const [name, ...args] = process.argv.slice(2);
	const words = positional(args);
	switch (name) {
		case "start": {
			const task = words[0];
			if (task === undefined) {
				return usage();
			}
			const key = option(args, "key");
			const frame = await command({
				command: "start",
				task,
				input: option(args, "input") ?? "",
				...(key === undefined ? {} : { key }),
			});
			if (frame.ok !== true) {
				return;
			}
			printData(frame);
			await tail(frame.data.session, 0);
			return;
		}
		case "tail": {
			const session = words[0];
			if (session === undefined) {
				return usage();
			}
			const after = option(args, "after");
			await tail(session, after === undefined ? undefined : Number(after));
			return;
		}
		case "steer":
		case "follow-up":
		case "prompt": {
			const session = words[0];
			const text = words.slice(1).join(" ");
			if (session === undefined || text === "") {
				return usage();
			}
			const frame = await command({
				command: name === "follow-up" ? "follow_up" : name,
				session,
				text,
			});
			if (frame.ok === true) {
				printData(frame);
			}
			return;
		}
		case "abort":
		case "resume": {
			const session = words[0];
			if (session === undefined) {
				return usage();
			}
			const frame = await command({ command: name, session });
			if (frame.ok === true) {
				printData(frame);
			}
			return;
		}
		case "messages": {
			const session = words[0];
			if (session === undefined) {
				return usage();
			}
			await messages(session, option(args, "entry"));
			return;
		}
		default:
			return usage();
	}
}

main().catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
