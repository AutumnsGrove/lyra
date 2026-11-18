/**
 * The test recipe: a stand-in for the development timeline (docs/recipes-and-tools.md,
 * "The test recipe"; decisions 60 and 116).
 *
 * The real timeline lives in Lattice, so this is generic and fake: the same shape of
 * tools, the same rules about what is exact, and nothing that touches the network. It
 * exists so the recipes-and-tools machinery is exercised end to end, in the scenario
 * files and in the resume test that kills it at every append.
 *
 * The state is the page and the handle table that names the day's commits. `setup`
 * mints `c1..cN`, each tool's `execute` reads the state and answers with what the
 * effect needs, and `apply` is the only writer, so replaying the saved results
 * rebuilds exactly the page a live run had (decision 112).
 */

import { defineRecipe } from "../core/define-recipe.js";
import { createFinishTool, coverageCheck } from "../core/finish.js";
import { createHandleTable, unknownHandle, type HandleTable } from "../core/handles.js";
import { isPlainObject } from "../core/json.js";
import { defineTool, type Tool, type ToolContext } from "../core/tool.js";

export interface TimelineCommit {
	handle: string;
	repo: string;
	sha: string;
	message: string;
}

export interface TimelineLine {
	id: string;
	text: string;
	cites: string[];
}

export interface TimelineProject {
	repo: string;
	lines: TimelineLine[];
}

export interface TimelinePage {
	projects: TimelineProject[];
	vines: { line: string; text: string }[];
	continuation?: { day: string; text: string };
}

export interface TimelineState {
	day: { repos: string[]; commits: TimelineCommit[] };
	handles: HandleTable;
	page: TimelinePage;
	/** The next line's number, so a resume numbers lines as the live run did. */
	nextLine: number;
	/** Call keys already applied, so a repeated call adds nothing (decision 24). */
	applied: string[];
}

const INPUT = {
	type: "object",
	properties: {
		repos: { type: "array", items: { type: "string" }, minItems: 1 },
		commits: {
			type: "array",
			items: {
				type: "object",
				properties: {
					repo: { type: "string" },
					sha: { type: "string" },
					message: { type: "string" },
				},
				required: ["repo", "sha", "message"],
			},
		},
	},
	required: ["repos", "commits"],
} as const;

const LINE_INPUT = {
	type: "object",
	properties: {
		project: { type: "string" },
		text: { type: "string", minLength: 1 },
		cites: { type: "array", items: { type: "string" }, minItems: 1 },
	},
	required: ["project", "text", "cites"],
} as const;

const PROJECT_INPUT = {
	type: "object",
	properties: { repo: { type: "string" } },
	required: ["repo"],
} as const;

const VINE_INPUT = {
	type: "object",
	properties: { line: { type: "string" }, text: { type: "string", minLength: 1 } },
	required: ["line", "text"],
} as const;

const CONTINUATION_INPUT = {
	type: "object",
	properties: { day: { type: "string" }, text: { type: "string", minLength: 1 } },
	required: ["day", "text"],
} as const;

/** The rendered day the model is given, with a handle for every commit. */
function renderDay(day: TimelineState["day"]): string {
	const commits = day.commits.map(
		(commit) => `${commit.handle} ${commit.repo} ${commit.sha} ${commit.message}`,
	);
	return [
		`The day has ${day.repos.length} repo(s): ${day.repos.join(", ")}.`,
		`Commits (${commits.length}):`,
		...commits,
	].join("\n");
}

function projectOf(state: TimelineState, repo: string): TimelineProject | undefined {
	return state.page.projects.find((project) => project.repo === repo);
}

function lineOf(state: TimelineState, id: string): TimelineLine | undefined {
	for (const project of state.page.projects) {
		const line = project.lines.find((candidate) => candidate.id === id);
		if (line !== undefined) {
			return line;
		}
	}
	return undefined;
}

function repoOfCommit(state: TimelineState, handle: string): string | undefined {
	const target = state.handles.resolve(handle);
	if (!isPlainObject(target) || typeof target["repo"] !== "string") {
		return undefined;
	}
	return target["repo"];
}

function startProject(): Tool {
	return defineTool({
		name: "start_project",
		description: "Start the section for a repo that is on the day's list.",
		parameters: PROJECT_INPUT,
		safeToRepeat: true,
		async execute(args, ctx: ToolContext<TimelineState>) {
			if (!ctx.state.day.repos.includes(args.repo)) {
				const real = ctx.state.day.repos.join(", ");
				return {
					isError: true,
					content: `there is no repo "${args.repo.slice(0, 60)}" on this day; the repos are ${real}`,
				};
			}
			if (projectOf(ctx.state, args.repo) !== undefined) {
				return { isError: false, content: `${args.repo} is already started` };
			}
			return {
				isError: false,
				content: `started a project for ${args.repo}`,
				details: { repo: args.repo },
			};
		},
		apply(state: TimelineState, args) {
			if (projectOf(state, args.repo) !== undefined) {
				return state;
			}
			return {
				...state,
				page: {
					...state.page,
					projects: [...state.page.projects, { repo: args.repo, lines: [] }],
				},
			};
		},
	});
}

function addLine(): Tool {
	return defineTool({
		name: "add_line",
		description: "Add a bullet to a project, citing at least one commit from that repo.",
		parameters: LINE_INPUT,
		safeToRepeat: true,
		async execute(args, ctx: ToolContext<TimelineState>) {
			const state = ctx.state;
			const project = projectOf(state, args.project);
			if (project === undefined) {
				const started = state.page.projects.map((one) => one.repo);
				return {
					isError: true,
					content: `there is no project "${args.project}"; ${
						started.length === 0
							? "no projects are started yet"
							: `the projects are ${started.join(", ")}`
					}`,
				};
			}
			for (const cite of args.cites) {
				if (!state.handles.has(cite)) {
					return { isError: true, content: unknownHandle(state.handles, cite, "c") };
				}
				const repo = repoOfCommit(state, cite);
				if (repo !== args.project) {
					return {
						isError: true,
						content: `${cite} is a commit in ${repo ?? "an unknown repo"}, not ${args.project}`,
					};
				}
			}
			const id = `l${state.nextLine}`;
			return {
				isError: false,
				content: `added ${id}: ${args.text}`,
				details: {
					id,
					project: args.project,
					text: args.text,
					cites: args.cites,
					key: ctx.callKey,
				},
			};
		},
		apply(state: TimelineState, args, outcome) {
			const details = outcome.details;
			const key =
				isPlainObject(details) && typeof details["key"] === "string" ? details["key"] : "";
			if (state.applied.includes(key)) {
				return state;
			}
			const id = `l${state.nextLine}`;
			const projects = state.page.projects.map((project) =>
				project.repo === args.project
					? {
							...project,
							lines: [
								...project.lines,
								{ id, text: args.text, cites: [...args.cites] },
							],
						}
					: project,
			);
			return {
				...state,
				page: { ...state.page, projects },
				nextLine: state.nextLine + 1,
				applied: [...state.applied, key],
			};
		},
	});
}

function addVine(): Tool {
	return defineTool({
		name: "add_vine",
		description: "Attach an aside to one line of the page.",
		parameters: VINE_INPUT,
		safeToRepeat: true,
		async execute(args, ctx: ToolContext<TimelineState>) {
			const state = ctx.state;
			if (lineOf(state, args.line) === undefined) {
				const lines = state.page.projects.flatMap((project) =>
					project.lines.map((line) => line.id),
				);
				return {
					isError: true,
					content: `there is no line "${args.line}"; ${
						lines.length === 0
							? "no lines are on the page yet"
							: `the lines are ${lines.join(", ")}`
					}`,
				};
			}
			return {
				isError: false,
				content: `attached a vine to ${args.line}`,
				details: { line: args.line, text: args.text, key: ctx.callKey },
			};
		},
		apply(state: TimelineState, args, outcome) {
			const details = outcome.details;
			const key =
				isPlainObject(details) && typeof details["key"] === "string" ? details["key"] : "";
			if (state.applied.includes(key)) {
				return state;
			}
			return {
				...state,
				page: {
					...state.page,
					vines: [...state.page.vines, { line: args.line, text: args.text }],
				},
				applied: [...state.applied, key],
			};
		},
	});
}

function markContinuation(): Tool {
	return defineTool({
		name: "mark_continuation",
		description: "Say this day continues what was done on an earlier one.",
		parameters: CONTINUATION_INPUT,
		safeToRepeat: true,
		async execute(args, ctx: ToolContext<TimelineState>) {
			if (!/^\d{4}-\d{2}-\d{2}$/.test(args.day)) {
				return {
					isError: true,
					content: `a continuation needs a day like 2026-11-17, not "${args.day.slice(0, 40)}"`,
				};
			}
			return {
				isError: false,
				content: `this day continues ${args.day}`,
				details: { day: args.day, text: args.text },
			};
		},
		apply(state: TimelineState, args) {
			return {
				...state,
				page: { ...state.page, continuation: { day: args.day, text: args.text } },
			};
		},
	});
}

function finish(): Tool {
	return createFinishTool<TimelineState>({
		check: (state, skipped) => {
			const covered = state.page.projects.flatMap((project) =>
				project.lines.flatMap((line) => line.cites),
			);
			return coverageCheck({
				expected: state.handles.list("c"),
				covered,
				label: "commits",
				skipped,
			});
		},
	});
}

/** The page as a string, which is what a resume test compares. */
export function renderPage(state: TimelineState): string {
	const lines: string[] = [];
	for (const project of state.page.projects) {
		lines.push(`## ${project.repo}`);
		for (const line of project.lines) {
			lines.push(`- ${line.id} ${line.text} [${line.cites.join(", ")}]`);
		}
	}
	for (const vine of state.page.vines) {
		lines.push(`* ${vine.line}: ${vine.text}`);
	}
	if (state.page.continuation !== undefined) {
		lines.push(`continues ${state.page.continuation.day}: ${state.page.continuation.text}`);
	}
	return lines.join("\n");
}

/** The day's handles in the order they were minted. */
export function renderHandles(state: TimelineState): string {
	return state.handles.list().join(", ");
}

export const timelineTestRecipe = defineRecipe({
	name: "timeline-test",
	version: 1,
	instructions:
		"You are building a day's page. Start a project for each repo you have something to say about, write lines that cite the commit handles, and call finish when every commit is covered by a line or skipped with a reason.",
	input: INPUT,
	setup: (input) => {
		const handles = createHandleTable();
		const commits = input.commits.map((commit) => ({
			handle: handles.mint("c", { repo: commit.repo, sha: commit.sha }),
			repo: commit.repo,
			sha: commit.sha,
			message: commit.message,
		}));
		const day = { repos: input.repos, commits };
		const state: TimelineState = {
			day,
			handles,
			page: { projects: [], vines: [] },
			nextLine: 1,
			applied: [],
		};
		return { message: renderDay(day), state };
	},
	tools: [startProject(), addLine(), addVine(), markContinuation(), finish()],
});
