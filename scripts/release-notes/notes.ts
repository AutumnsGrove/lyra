import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * The release body, from the tag range (`docs/release-notes.md`).
 *
 * A body is a courtesy, so nothing here may block a release. The agent's answer
 * is the body when it is usable; otherwise the changelog section is, and when
 * there is no section either the release publishes with no body at all. Status
 * `3` is how this says which of those happened, so a silent fallback cannot
 * hide in a green release.
 *
 * This runs with no build step on Node's type stripping, so only erasable
 * syntax is allowed: no enums, no namespaces, no parameter properties, and
 * `import type` for types (decision 120).
 */

/** The environment a child gets. `undefined` is allowed so a test can unset one. */
export type Env = Record<string, string | undefined>;

export interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/** Pinned so a release is reproducible: the same agent `pi-review` runs. */
const DEFAULT_PROVIDER = "opencode-go";
const DEFAULT_MODEL = "deepseek-v4.1-flash";
const DEFAULT_THINKING = "high";
/**
 * A body is a summary, not a changelog. Sixteen kilobytes is about forty bullets
 * with room for upgrade notes, which covers a release with a lot of work behind
 * it while still refusing an answer that has become the commit log.
 */
const DEFAULT_MAX_BYTES = 16 << 10;
/** A CI run took 4m41s for one release on Nova, so five minutes is no headroom. */
const DEFAULT_TIMEOUT_MS = 12 * 60 * 1000;
/** git's hash of an empty tree: the diff base of a first release, which has no previous tag. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Read-only inspection, plus `bash` on a runner that is thrown away (decision 76). */
const AGENT_TOOLS = "read,grep,find,ls,bash";

const USAGE = "usage: release-notes [flags] [previous-tag] <tag> (flags come before the refs)";

interface Options {
	from: string;
	to: string;
	version: string;
	repo: string;
	changelog: string;
	out: string;
	provider: string;
	model: string;
	thinking: string;
	maxBytes: number;
	timeout: number;
	promptOnly: boolean;
	check: boolean;
	pkg: string;
	dryRun: boolean;
	tag: string;
}

/** Everything the agent is given. The changelog section and the log are equal evidence. */
interface Evidence {
	from: string;
	to: string;
	version: string;
	commits: string;
	count: number;
	diffstat: string;
	changelog: string;
}

interface Io {
	out: (text: string) => void;
	err: (text: string) => void;
}

export async function run(argv: string[], env: Env = process.env): Promise<RunResult> {
	const stdout: string[] = [];
	const stderr: string[] = [];
	const io: Io = { out: (text) => stdout.push(text), err: (text) => stderr.push(text) };
	let code = 2;
	try {
		code = await main(argv, env, io);
	} catch (error) {
		io.err(`release-notes: ${message(error)}\n`);
	}
	return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}

async function main(argv: string[], env: Env, io: Io): Promise<number> {
	const parsed = parse(argv);
	if ("error" in parsed) {
		io.err(`release-notes: ${parsed.error}\n`);
		return 2;
	}
	const options = parsed.options;
	if (options.check) {
		return checkRelease(options, io);
	}
	const evidence = await collect(options, env);
	const prompt = await buildPrompt(evidence);
	if (options.promptOnly) {
		io.out(prompt);
		return 0;
	}
	const answer = await generate(options, prompt, env);
	if (answer.why !== "") {
		io.err(`release-notes: ${answer.why}; falling back to the changelog\n`);
	}
	let body = answer.body;
	if (body === "") {
		body = clean(evidence.changelog);
		if (body === "") {
			io.err(
				`release-notes: no changelog section for ${evidence.version} either; publishing no body\n`,
			);
		}
	}
	await emit(options, io, body);
	return answer.why === "" ? 0 : 3;
}

/** One ref is a first release, two are a range. Flags come before the refs, and the usage says so. */
function parse(argv: string[]): { options: Options } | { error: string } {
	const options: Options = {
		from: "",
		to: "",
		version: "",
		repo: ".",
		changelog: "CHANGELOG.md",
		out: "",
		provider: DEFAULT_PROVIDER,
		model: DEFAULT_MODEL,
		thinking: DEFAULT_THINKING,
		maxBytes: DEFAULT_MAX_BYTES,
		timeout: DEFAULT_TIMEOUT_MS,
		promptOnly: false,
		check: false,
		pkg: "packages/lyra/package.json",
		dryRun: false,
		tag: "",
	};
	const refs: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const argument = argv[i] ?? "";
		if (!argument.startsWith("--")) {
			refs.push(argument);
			continue;
		}
		// A flag after a ref is an error rather than something ignored, because Go's
		// flag package and every shell wrapper around it disagree about it (RN12).
		if (refs.length > 0) {
			return { error: `${argument} came after the refs; flags come first\n${USAGE}` };
		}
		const equals = argument.indexOf("=");
		const name = equals < 0 ? argument : argument.slice(0, equals);
		const inline = equals < 0 ? undefined : argument.slice(equals + 1);
		const value = (): string | undefined => {
			if (inline !== undefined) {
				return inline;
			}
			i += 1;
			return argv[i];
		};
		if (VALUE_FLAGS.has(name)) {
			const given = value();
			if (given === undefined) {
				return { error: `${name} needs a value\n${USAGE}` };
			}
			if (NUMBER_FLAGS.has(name)) {
				const number = Number(given);
				if (!Number.isSafeInteger(number) || number <= 0) {
					return {
						error: `${name} needs a positive whole number, not ${JSON.stringify(given)}\n${USAGE}`,
					};
				}
			}
			setOption(options, name, given);
			continue;
		}
		switch (name) {
			case "--prompt-only":
				options.promptOnly = true;
				break;
			case "--check":
				options.check = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			default:
				return { error: `unknown flag ${name}\n${USAGE}` };
		}
	}
	if (options.check) {
		if (options.tag === "") {
			return { error: `--check needs --tag\n${USAGE}` };
		}
		if (refs.length > 0) {
			return { error: `--check takes no refs\n${USAGE}` };
		}
		return { options };
	}
	if (refs.length === 1) {
		options.to = refs[0] ?? "";
	} else if (refs.length === 2) {
		options.from = refs[0] ?? "";
		options.to = refs[1] ?? "";
	} else {
		return { error: USAGE };
	}
	if (options.from === options.to) {
		return { error: `range ${options.from}..${options.to} is empty\n${USAGE}` };
	}
	return { options };
}

/** The version a tag names: the changelog writes `## [0.2.0]`, the tag is `v0.2.0`. */
function versionOf(name: string): string {
	return name.startsWith("v") ? name.slice(1) : name;
}

async function collect(options: Options, env: Env): Promise<Evidence> {
	const version = versionOf(options.version === "" ? options.to : options.version);
	const evidence: Evidence = {
		from: options.from,
		to: options.to,
		version,
		commits: "",
		count: 0,
		diffstat: "",
		changelog: "",
	};
	await stat(options.repo).catch((error: unknown) => {
		throw new Error(`repository ${options.repo}: ${message(error)}`);
	});
	const range = evidence.from === "" ? evidence.to : `${evidence.from}..${evidence.to}`;
	const count = await git(options.repo, env, ["rev-list", "--no-merges", "--count", range]);
	evidence.count = Number(count.trim());
	// Merges are excluded because a pull request's commits are the change and its
	// merge commit is the plumbing. %b keeps the body, which carries the why.
	evidence.commits = await git(options.repo, env, [
		"log",
		"--no-merges",
		"--reverse",
		"--format=%s%n%b",
		range,
	]);
	const base = evidence.from === "" ? EMPTY_TREE : evidence.from;
	evidence.diffstat = await git(options.repo, env, [
		"diff",
		"--stat",
		"--no-color",
		base,
		evidence.to,
	]);
	evidence.changelog = await changelogSection(options.repo, options.changelog, version);
	if (!Number.isSafeInteger(evidence.count)) {
		throw new Error(`the range ${range} did not report a commit count`);
	}
	return evidence;
}

function git(repo: string, env: Env, args: string[]): Promise<string> {
	return new Promise((done, fail) => {
		const child = spawn("git", ["-C", repo, ...args], { env });
		let out = "";
		let err = "";
		child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
			out += chunk;
		});
		child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
			err += chunk;
		});
		child.on("error", (error) => {
			fail(new Error(`git ${args[0] ?? ""}: ${error.message}`));
		});
		child.on("close", (status) => {
			// A missing ref is the common failure, so its stderr is the message rather
			// than a bare exit status.
			if (status === 0) {
				done(out);
				return;
			}
			fail(
				new Error(
					`git ${args[0] ?? ""}: ${err.trim() || `exited with ${status ?? "no status"}`}`,
				),
			);
		});
	});
}

/**
 * A version's content without its heading, stopping at the next `## ` heading. A
 * missing file or section is not an error: the range is still worth summarising,
 * and the caller reports the empty fallback.
 */
async function changelogSection(repo: string, name: string, version: string): Promise<string> {
	let content: string;
	try {
		content = await readFile(join(repo, name), "utf8");
	} catch (error) {
		if (isMissing(error)) {
			return "";
		}
		throw new Error(`read ${name}: ${message(error)}`);
	}
	const lines = content.split("\n");
	const head = `## [${version}]`;
	const start = lines.findIndex((line) => line.trimStart().startsWith(head));
	if (start < 0) {
		return "";
	}
	const rest = lines.slice(start + 1);
	const next = rest.findIndex((line) => line.startsWith("## "));
	const section = next < 0 ? rest : rest.slice(0, next);
	return section.join("\n").trim();
}

const VALUE_FLAGS = new Set([
	"--repo",
	"--changelog",
	"--version",
	"--out",
	"--provider",
	"--model",
	"--thinking",
	"--max-bytes",
	"--timeout",
	"--package",
	"--tag",
]);
const NUMBER_FLAGS = new Set(["--max-bytes", "--timeout"]);

/** Assigns a flag that takes a value. The name is already known to be one of VALUE_FLAGS. */
function setOption(options: Options, name: string, value: string): void {
	switch (name) {
		case "--repo":
			options.repo = value;
			break;
		case "--changelog":
			options.changelog = value;
			break;
		case "--version":
			options.version = value;
			break;
		case "--out":
			options.out = value;
			break;
		case "--provider":
			options.provider = value;
			break;
		case "--model":
			options.model = value;
			break;
		case "--thinking":
			options.thinking = value;
			break;
		case "--max-bytes":
			options.maxBytes = Number(value);
			break;
		case "--timeout":
			options.timeout = Number(value);
			break;
		case "--package":
			options.pkg = value;
			break;
		case "--tag":
			options.tag = value;
			break;
		default:
			break;
	}
}

async function buildPrompt(evidence: Evidence): Promise<string> {
	const rules = (await readFile(join(import.meta.dirname, "prompt.md"), "utf8")).trim();
	const range = evidence.from === "" ? evidence.to : `${evidence.from}..${evidence.to}`;
	const parts: string[] = [rules, "\n# Evidence\n\n"];
	parts.push(`## The changelog section for ${evidence.version}\n\n`);
	if (evidence.changelog === "") {
		parts.push(
			`None: the changelog has no section for ${evidence.version}, so the commit log is the only evidence.\n\n`,
		);
	} else {
		parts.push(`${evidence.changelog}\n\n`);
	}
	if (evidence.from === "") {
		parts.push(
			`This is the first release: there is no previous tag, so the commits and the diffstat cover the whole history up to ${evidence.to}.\n\n`,
		);
	}
	parts.push(`## ${evidence.count} commits in ${range}, merges excluded, oldest first\n\n`);
	parts.push(`${evidence.commits.trim()}\n\n`);
	parts.push(`## Diffstat for ${range}\n\n\`\`\`\n${evidence.diffstat.trim()}\n\`\`\`\n`);
	return parts.join("");
}

interface Answer {
	body: string;
	why: string;
}

/** Runs the agent and vets its answer. A non-empty `why` means the caller must fall back. */
async function generate(options: Options, prompt: string, env: Env): Promise<Answer> {
	const pi = await lookPath("pi", env["PATH"] ?? "");
	if (pi === null) {
		return { body: "", why: "pi is not installed" };
	}
	const args = [
		"-p",
		"--mode",
		"text",
		"--no-session",
		"-na",
		"-nc",
		"--offline",
		"-ne",
		"-ns",
		"-np",
		"--no-themes",
		"--no-mcp",
		"--tools",
		AGENT_TOOLS,
		"--provider",
		options.provider,
		"--model",
		options.model,
		"--thinking",
		options.thinking,
	];
	const child = spawn(pi, args, { env, detached: true });
	let out = "";
	let err = "";
	child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
		out += chunk;
	});
	child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
		err += chunk;
	});
	let late = false;
	// pi runs tools, so a tool can leave a child holding the output pipe. The
	// deadline has to kill the whole group, not only pi: a killed pi whose child
	// still holds the pipe keeps the wait blocked, and the deadline stops bounding
	// wall clock (RN07).
	const timer = setTimeout(() => {
		late = true;
		if (child.pid !== undefined) {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
		}
	}, options.timeout);
	// A child that exits before reading its stdin turns the prompt into a broken
	// pipe, and an unhandled stream error would end the script instead of falling
	// back. The answer is what matters; a refused stdin only means it was never
	// read.
	child.stdin?.on("error", () => {});
	child.stdin?.end(prompt);
	const status = await new Promise<number | null>((done) => {
		child.on("error", () => done(null));
		child.on("close", (code) => done(code));
	});
	clearTimeout(timer);
	if (late) {
		return { body: "", why: `the agent did not finish within ${options.timeout}ms` };
	}
	if (status !== 0) {
		const said = err.trim();
		const shown = said.length > 300 ? `${said.slice(0, 300)}...` : said;
		return {
			body: "",
			why: `the agent failed: ${shown === "" ? `exit ${status ?? "unknown"}` : shown}`,
		};
	}
	const body = clean(out);
	if (body === "") {
		return { body: "", why: "the agent returned an empty body" };
	}
	if (byteLength(body) > options.maxBytes) {
		return {
			body: "",
			why: `the agent returned ${byteLength(body)} bytes, over the ${options.maxBytes}-byte cap`,
		};
	}
	if (!hasStructure(body)) {
		return { body: "", why: "the agent returned no headings or bullets" };
	}
	if (safeToPublish(body)) {
		return {
			body: "",
			why: "the agent returned what looks like a secret, and the body is public",
		};
	}
	return { body, why: "" };
}

/** The answer is published to a public page, so a leak there is a leak that cannot be taken back. */
const SECRET_SHAPES = [
	/\bsk-[A-Za-z0-9_-]{8,}/,
	/\bBearer\s+[A-Za-z0-9._-]{8,}/,
	/[A-Za-z0-9+/_-]{40,}={0,2}/,
];

function safeToPublish(body: string): boolean {
	return SECRET_SHAPES.some((shape) => shape.test(body));
}

/** Terminal escapes a model's answer can carry; the pattern is Nova's, unchanged. */
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/**
 * Makes an answer safe to publish: no terminal escapes, no fence around the whole
 * body, no trailing spaces, and at most one blank line between blocks.
 */
function clean(answer: string): string {
	let lines = answer.replace(ANSI, "").replace(/\r\n/g, "\n").split("\n");
	lines = lines.map((line) => line.replace(/[ \t\r]+$/, ""));
	// Blank edge lines go first, so the fence check sees the real first and last
	// line rather than the empty tail after the final newline.
	while (lines.length > 0 && (lines[0] ?? "").trim() === "") {
		lines = lines.slice(1);
	}
	while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") {
		lines = lines.slice(0, -1);
	}
	const first = (lines[0] ?? "").trim();
	const last = (lines[lines.length - 1] ?? "").trim();
	if (lines.length > 1 && first.startsWith("```") && last.startsWith("```")) {
		lines = lines.slice(1, -1);
	}
	let joined = lines.join("\n");
	while (joined.includes("\n\n\n")) {
		joined = joined.replaceAll("\n\n\n", "\n\n");
	}
	const trimmed = joined.trim();
	return trimmed === "" ? "" : `${trimmed}\n`;
}

/** Prose and preamble are not a release body: something has to be a heading or a bullet. */
function hasStructure(body: string): boolean {
	return body
		.split("\n")
		.map((line) => line.trim())
		.some((line) => ["## ", "### ", "- ", "* "].some((prefix) => line.startsWith(prefix)));
}

async function emit(options: Options, io: Io, body: string): Promise<void> {
	if (options.out === "") {
		io.out(body);
		return;
	}
	try {
		await writeFile(options.out, body);
	} catch (error) {
		throw new Error(`write ${options.out}: ${message(error)}`);
	}
	io.err(`release-notes: wrote ${byteLength(body)} bytes to ${options.out}\n`);
}

/**
 * `--check`: the release job's first step. A publish that disagrees with its tag
 * is worse than a failed release, so the tag and the package version have to
 * match and the changelog has to have a section to write from. A dry run says
 * the same things as warnings, because it rehearses a version that may not be
 * ready yet.
 */
async function checkRelease(options: Options, io: Io): Promise<number> {
	const version = versionOf(options.version === "" ? options.tag : options.version);
	const problems: string[] = [];
	let published = "";
	try {
		const raw = await readFile(join(options.repo, options.pkg), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (isRecord(parsed) && typeof parsed["version"] === "string") {
			published = parsed["version"];
		}
	} catch (error) {
		problems.push(`cannot read ${options.pkg}: ${message(error)}`);
	}
	if (published === "" && problems.length === 0) {
		problems.push(`${options.pkg} has no version`);
	} else if (published !== "" && published !== version) {
		problems.push(`the tag says ${version} and ${options.pkg} says ${published}`);
	}
	const section = await changelogSection(options.repo, options.changelog, version);
	if (section === "") {
		problems.push(`${options.changelog} has no section for ${version}`);
	}
	if (problems.length === 0) {
		return 0;
	}
	const level = options.dryRun ? "warning" : "error";
	for (const problem of problems) {
		io.err(`release-notes: ${level}: ${problem}\n`);
	}
	return options.dryRun ? 0 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissing(error: unknown): boolean {
	return isRecord(error) && error["code"] === "ENOENT";
}

/** Finds a command on a PATH, so a machine without the agent is a warning and not a crash. */
async function lookPath(name: string, path: string): Promise<string | null> {
	for (const dir of path.split(":")) {
		if (dir === "") {
			continue;
		}
		const candidate = join(dir, name);
		try {
			await access(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return null;
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
