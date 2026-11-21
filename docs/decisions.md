---
title: "Lyra decisions"
status: planning
category: features
---

# Lyra decisions

A running log. Newest decisions go at the bottom of the decided list. Each entry says what was decided, why, and what it rules out.

Last updated: 2026-11-17.

## Decided

### 1. The name is Lyra
Lyra names both the core and the agent, the way Nova does. A slight personhood is intended: "Lyra parked the run and is waiting on approval" is a sentence it should be able to say. Features are "powered by Lyra". Chosen 2026-11-12 after the naming journey (see the link in the README).

### 2. What Lyra is, and is not
Lyra is a tool-calling loop. It is not a coding agent, now or later. It has no subagents, because a single loop with the right tools covers what Forage's pseudo-subagents do (to be confirmed when Forage is ported). It has no skills system. MCP can arrive later as an adapter and stays out of the core. A bash-like scratchpad can arrive later as one more tool (just-bash is the candidate; its core runs in browsers, and it has not been tested on Workers).

### 3. In Grove, models are reached through Lumen, as a plain transport
Inside Grove, every model call goes through Lumen. Lyra itself only needs "something that answers a model request", so Lumen is Grove's adapter, not part of Lyra's core (see decision 12 and `adapters.md`). Lumen has to be upgraded first (see `lumen-changes.md`). Lumen stays a transport: it carries messages and results faithfully and keeps routing, scrubbing, quota, and logging. It never runs the loop or the tools.

### 4. The first job is the timeline summary
The model writes the words. Tools own anything that has to be exact: repo names, links, and where each vine attaches. A `finish` tool refuses to end the job until everything that happened that day is covered. Full scope in `timeline-first-job.md`.

### 5. Each task is a recipe, with shared tools
A task defines four things: its instructions, its tools, its limits, and what counts as done. Common tools (finish, search past runs, ask a human) live in a shared pile any task can pick from. Task-specific tools belong to the task. There is no tool search for now. Each task's tool list is a plain list we control, so a "find a tool" step can be added later. Lumen currently accepts up to 64 tools per request, which is plenty.

### 6. Timeline data is passed up front, in full
The day's repos, commits, pull requests, issue activity, and line counts all go to the model at the start. Tools are for digging deeper (a diff, an issue thread, earlier days) and for building the page. A very large day (hundreds of commits and PRs) is a known limit. It is accepted for now, because the timeline has one user. A step limit and a clear "too big" failure are enough.

### 7. Scope first, build later
Everything is written down before anything is built. Open questions are settled now, before implementation starts. The work moves to a new repository once the scope is complete and understood.

### 8. Tool results are scrubbed like everything else
Lumen's privacy scrubber (emails, phone numbers, IP addresses, card and SSN patterns) applies to tool results as well. The data is private, and scrubbing it is the point of that system. Consequence: the scrubber can change text the model needs, so tools should hand the model short handles (for example `c1`, `pr12`, `i34`) that Lyra maps back to real commit hashes, links, and numbers, and the model should never have to copy a long exact string. See the design note in `timeline-first-job.md`.

### 9. Songbird stays as it is
Songbird checks only what a Wanderer types, for prompt injection. It does not inspect tool results or judge tool calls. That would be extra overhead for something not needed, and it is not what Songbird is for. The defense for tool results is that each task only has the tools it needs, so a poisoned issue comment can at worst mislead a summary.

### 10. Quota and step limits
The timeline skips Lumen's request quota for now (Lumen has a `skipQuota` option). Lyra's maximum number of steps is an option, and the default in the core is no limit. A task can set its own limit in its recipe. The timeline recipe's step limit is set in decision 92. Cloudflare's own limits still apply either way.

### 11. Lumen gets its own `agent` task
Agent calls use a new task type in Lumen, with its own default model, its own quota line, and its own settings. It does not reuse `summary` or `chat`.

### 12. Lyra runs anywhere, with Grove's pieces as adapters
Lyra's core defines small slots (model, storage, secrets, waking) and imports nothing from Lumen, Warden, Cloudflare, or Node. Grove supplies adapters (Lumen, Warden, Durable Objects). Other projects supply simpler ones. The list of slots is expected to grow as more places Lyra runs are discussed. Confirmed 2026-11-13. Full description in `adapters.md`.

The first adapters: Lumen, Durable Object storage and alarm, in-memory storage, and a plain OpenAI-style model adapter for other projects. Also expected to grow.

### 13. Cloudflare is the main development target, and Lyra also runs without it
Cloudflare Workers is the hardest environment (no filesystem, no subprocesses, limits on time and memory), so it is the one to develop against. The core must also run on Node with the same code. Developing against the stricter environment is what keeps the core portable.

### 14. Model connections: OpenRouter first, OpenCode Go second, chat-completions only at first
Autumn's two model providers are OpenRouter (primary) and OpenCode Go (an OpenAI-style endpoint with a shared subscription quota, used for example on a GitHub Action runner). Nova found that OpenCode Go is not one dialect: it needed three (chat completions, OpenAI Responses, and Anthropic Messages), because different models on that gateway speak different ones. The first model adapter speaks chat completions only, which serves OpenRouter and OpenCode Go with different settings, and only models that speak it are used. Other dialects are added when a model that needs one is tested. Confirmed 2026-11-13. See `adapters.md`.

### 15. Usage always carries tokens, and cost carries its source
OpenCode Go bills against a shared subscription allowance, not per-call dollars, and some models cost more at certain hours. So the model slot reports tokens every time, and reports cost only when the adapter knows it, labeled with where it came from (provider, allowance, or catalog estimate). Limits on tokens, steps, and time always work. A limit on cost works only when the adapter reports real cost. Nova already does this. Confirmed 2026-11-13.

### 16. File and shell tools are allowed, as task-level tools that depend on the host
Tools belong to tasks, and some tools only make sense on some hosts. A task running on a Node host, such as a GitHub Action runner doing a review, can have file and shell tools. A Cloudflare Worker has no filesystem and no subprocesses, so it does not. None of this enters the core. No dedicated write tool is planned, because tools are shaped to what each task needs.

For a runner task, Autumn wants a real bash tool. It needs to run tests, and models are trained on `grep`, `find`, and `glob`, so they use those more readily than custom search tools when the shell is allowed. Confirmed 2026-11-13.

Two consequences to carry forward. First, bash is free-form, so it is the one tool that cannot be validated the way the timeline's tools are. The working rule: validated tools for tasks where exactness matters (the timeline), a shell for exploratory tasks (a review). Second, a shell can write and run anything the host allows, so it needs a permission policy. That belongs to the approvals discussion, and Nova's permission model is the reference.

### 17. A shell slot, optional
A fifth slot: run a command and return its output. A task that needs a shell says so, and fails clearly on a host that has none. The tool is called `bash` everywhere, so a task's recipe does not change between hosts. On Node the slot runs a real shell. On Workers there is none at first (a virtual shell such as just-bash could fill it later, untested). This keeps subprocess code out of the core. Confirmed 2026-11-14.

### 18. Limits are optional, and there are none by default
A run can be limited by steps, tokens, time, or cost. Each is optional, and the core's default is no limit on any of them. A task can set any in its recipe. A cost limit works only when the adapter reports real cost (decision 15). Extends decision 10. Decided 2026-11-14. See `limits-and-interruptions.md`.

### 19. A run can always be stopped and steered
Any run can be stopped partway by a person, and steered with a new message that redirects it. A stop cancels the model request in flight. A steer message is read by the model at the next gap between steps. Always available, whatever the task. Decided 2026-11-14.

### 20. Interrupted runs resume where they stopped
After every model reply and tool result, the record is saved before the loop goes on. Resuming reloads the record and continues. A run does not start over. Decided 2026-11-14.

### 21. Tool failures go back to the model
A failed tool call, or one with invalid arguments, returns an error as the tool's result, and the model corrects it in the next call. Bad model output is a fact of working with AI, and Lyra does not try to design it away. Decided 2026-11-14.

### 22. Hitting a limit parks the run
A run that reaches a limit is parked, not killed. Everything done so far is kept, and the run can be resumed with a larger limit or left alone. Decided 2026-11-14.

### 23. Accidents resume on their own, and a stop waits for a person
If the host crashes or evicts a run, the Waking slot resumes it with nobody asking. A run a person stopped stays stopped until told to resume. Decided 2026-11-14.

### 24. Each tool declares whether it is safe to repeat
The default is no. A tool that was cut off partway and is not safe to repeat is reported to the model as "outcome unknown, check before repeating", not run again. Tools that change things can be made safe with a call id built from the run and the step. Decided 2026-11-14.

### 25. Done is decided by the task's done-check, with a configurable stuck safeguard
A run is done when the task's done-check passes (for the timeline, `finish` was accepted), not when the model says so. If the model stops without finishing, Lyra reminds it a small number of times, then parks the run as stuck. If a tool fails the same way several times in a row, the run also parks as stuck. This is the one default-on safeguard, and it is configurable per task (whether it is on, and the counts). A reply cut off by the token limit never runs its half-written tool arguments. Decided 2026-11-14.

### 26. A failing model call is retried 3 times, with staggered backoff
Up to 3 retries, with increasing delays between attempts. The exact delays are configuration, chosen when building. After the third failure the run parks with the reason "model unavailable". Correction (2026-11-15): Lumen's router does not fall back between models when tools are present, so these retries are the only protection for agent calls, and a recipe may name a fallback model (decision 58). Decided 2026-11-14.

### 27. A follow-up message is supported
A message can be queued during a run and is read after the work would otherwise end, in the same conversation. It sits next to stop and steer (decision 19). Nova and Pi both have it. Decided 2026-11-14. Open detail: what a follow-up does when nothing is running.

### 28. The core only produces the record
The core makes a clean, readable record of every run. A viewer (an Arbor page, a file, or anything else) is built separately later, on top of it. Decided 2026-11-14. See `run-record.md`.

### 29. The record holds the real data
Scrubbing happens only on the way to the model. The saved record is private to the tenant, is never published, and never contains a provider key. Decided 2026-11-14.

### 30. A straight line now, with branches possible later
Nothing branches today. Every entry carries its own id and the id of the entry before it, so branches can be added later without changing the format. Decided 2026-11-14.

### 31. The record is shaped like Nova's session file
A header line, then one entry per line. Each entry has `type`, `id`, `parent`, and `ts`. Entries: header, message from the user, message from the assistant (with model, usage, finish reason), message from a tool, and status. Unknown kinds are skipped by readers. Confirmed 2026-11-14.

### 32. The record is the only place progress lives
Working state that tools build (the half-built timeline page, the handle map) is rebuilt on resume by replaying the saved tool results. No second copy. Tools are written so that replaying their saved results rebuilds their state. Confirmed 2026-11-14, with the aim of full observability.

### 33. The model's reasoning text is stored when the adapter provides it
Marked as reasoning, so a viewer can show or hide it. Confirmed 2026-11-14.

### 34. One mechanism for approvals and questions
A pending request is saved in the record and the run parks as "waiting for a person". The answer is approve, deny (with a note the model reads), or the answer to a question. The shared "ask a human" tool and the approval check on risky tools are the same thing. Confirmed 2026-11-14. See `approvals.md`.

### 35. A policy per tool, set in the task's recipe
Each tool is allow, ask, or deny. A risk label (reads, changes things, dangerous) sets the default. If a call needs an answer and nothing can deliver the question, it is denied. Confirmed 2026-11-14.

### 36. A waiting run shows as a simple indicator, not a message
No email and no push. A waiting run is shown as a soft glow, a quiet indicator. The core only makes waiting runs easy to see (a list of pending requests and what each asks). The glow itself is part of the viewer, built later (decision 28). Because of that, no separate notify slot is needed for now. Replaces the notify slot first proposed. Decided 2026-11-14.

### 37. An optional timeout per task, with no timeout by default
After the timeout, an unanswered request is denied. Useful for tasks that run in the background. Confirmed 2026-11-14.

### 38. The shell tool moves long commands to the background
A command still running at a deadline keeps running instead of being killed. The model gets an id and carries on, and is told when the command exits. It can look at the output so far, wait for it, or stop it. This follows Autumn's `pi-background` extension. While a request is pending, the exit notice queues (see the design note in `approvals.md`). Decided 2026-11-15. Open details: the default deadline, how long finished jobs are remembered, and what happens to a running command when the host process is lost.

### 39. The record keeps everything, and the model sees a built view
Compaction adds a `compaction` entry with a summary and a pointer to the first entry kept. It never deletes from the record. The cut never falls between a tool call and its result, and recent steps stay verbatim. Confirmed 2026-11-15. See `context-size.md`.

### 40. What survives compaction is decided by the task
The task's instructions are pinned and never summarized. Tools can supply a "current state" shown after a compaction (for the timeline, the page so far), which is exact and replaces prose wherever a tool can provide it. The task supplies the summarizer's instructions, with a generic default. Bulky tool results are capped when they arrive. Confirmed 2026-11-15.

### 41. Compaction triggers from the tokens Lumen reports
When the last request's input tokens pass the model's context window minus a reserve. Reserve and amount kept are configurable per task. Needs a `contextWindow` field per model in `lumen-models.json`. If the first message alone is too large, the run fails clearly with "input too large". Confirmed 2026-11-15.

### 42. Compaction is part of the first version
It will rarely fire, because tasks are small and most models have very large windows. Autumn wants it from the start anyway, so a long run never has to stop at the limit. This overrides a proposal to build it last. Decided 2026-11-15. See `context-size.md`.

### 43. Lyra speaks Nova's frames
A subset of Nova's frames (`hello`, commands, `response`, `event`, `ui_request`, `ui_response`), plus a few new ones for starting a task, resuming a parked run, and listing pending requests. One client could drive either Nova or Lyra. Decided 2026-11-15. See `protocol.md`.

### 44. A session holds many runs, like Nova
A client talks to a session, which is a conversation that can hold many runs. Each timeline day would be a session with one run. A chat-style use later fits the same shape. A follow-up sent after a run has ended starts the next run in the same session, which settles the open detail in decision 27. Decided 2026-11-15. See `protocol.md`.

### 45. HTTP with server-sent events and WebSocket, both from the start
Both transports are built together. HTTP: a command is a normal request, and events arrive on a stream (as in Nova's serve mode). WebSocket: one connection both ways, which suits live stop, steer, and approvals. Other Grove workers reach Lyra through a service binding. Decided 2026-11-15. This is more to build first, and the cost is accepted. Neither transport is part of the core, because the core only speaks frames (see decision 12).

### 46. A `start` command begins a task
A new command, `start`, names a task and passes its inputs, for example the timeline for a given date. Nova's `prompt` stays for chat-style use, where the task is a general conversation. Decided 2026-11-15. See `protocol.md`.

### 47. Access: service bindings plus a token, one owner for now
Other Grove workers reach Lyra through a service binding. Anything from outside needs a bearer token. Every session is owned by a tenant id, stored on its record, so per-tenant checks can be added later without changing the format. No Heartwood sign-in per call for now, because the only task is Autumn's. Decided 2026-11-15.

### 48. The stateless calls stay out of Lyra
Decision models, embeddings, speech, and transcription are single calls, not runs. They stay in Lumen, where they live or are planned, and Lyra does not expose them. This keeps the core small, and they can be added later without changing anything else. Decided 2026-11-15.

### 49. The timeline is the first job, and HawkAgent is second
Keeps decision 4. HawkAgent (#1684) layer 2 follows once the core works. Its needs shape the design now: a session that lives for days (decision 44 covers it, with the host doing the scheduling), results that a person dispositions later, and records that go with the tenant. Decided 2026-11-15. See `consumers.md`.

### 50. The core has a proposal type
A run can end with a proposal: a typed result with its evidence and a review state (open, accepted, or rejected). This is for work where a person decides later whether to act, which is how HawkAgent and several other planned consumers work. It is different from an approval, which pauses a run before an action (decisions 34 to 37). This was chosen over keeping proposals in the app and having the core know only a structured final result. Decided 2026-11-15. Open details (fields, how a decision is made, and how it reaches the app) are in `consumers.md`.

### 51. Records belong to the tenant
A run's record is deleted when its tenant is removed, and otherwise kept until the app prunes it. The core does not prune on its own. Anything that must outlive the tenant is written by the app into its own table, like HawkAgent's verdict. Decided 2026-11-15. This answers record retention.

### 52. A proposal has a typed payload, evidence references, and a state
The task defines the shape of the payload (for HawkAgent, a score and a verdict). Evidence is a list of references to what supports it. The state is open, accepted, or rejected. A viewer can show any proposal without knowing the task. Decided 2026-11-15. Completes decision 50.

### 53. A decision is saved in the record and emitted as an event the app copies out
When a person accepts or rejects a proposal (with an optional note), the core saves the decision as a new entry in the record and emits a decision event. The app listens and writes whatever must last, such as HawkAgent's label, into its own table. The core never keeps anything past the tenant (decision 51). Decided 2026-11-15.

### 54. The vine placement fix is a separate GitHub issue, not Lyra's work
Letting the timeline page attach a vine to a specific line is a change to the page (`libs/curios/src/timeline/Timeline.svelte` and its parser), and it improves the timeline whether or not Lyra exists. It is tracked in its own issue, #1687. Lyra's timeline task does not wait for it: until it lands, the task attaches vines to headings, as the page does today. The two approaches and the recommendation are written up in `timeline-first-job.md` and go into the issue. Decided 2026-11-15.

### 55. GroveAgent is out of date and is not a basis for Lyra
`libs/grove-agent` and the consumers plan (`docs/plans/infra/planned/grove-agent-consumers.md`) are stale: the library pins `agents ^0.6.0` and was last touched in early September, and Cloudflare's own package has moved on. Lyra is built from scratch. The old plan is not a source of truth for what will use Lyra, and the Cloudflare adapter does not assume `GroveAgent`. Decided 2026-11-15. This removes `GroveAgent` as an option for the adapter's foundation.

### 56. Lyra serves interactive uses as well as background jobs
Autumn named further consumers: Wisp (a writing assistant, currently parked in the junk drawer), Fireside (a conversational writing mode of Wisp), and Reverie (a chatbot-style theme engine that tweaks a grove). All three are interactive, with a Wanderer in the conversation, unlike the timeline and HawkAgent. Nothing in the existing decisions has to change, because sessions with many runs, steering, follow-ups, live approvals, and WebSocket were already decided. It does affect Lumen: streaming is not needed for the first job but is needed for these. Decided 2026-11-15. See `consumers.md`.

### 57. The Lumen build order is L1 to L6
L1: messages carry tool turns. L2: the response reports why the model stopped. L3: a new `agent` task, with quotas set to zero in every tier so agent calls must skip quota until a real rule exists. L4: model flags (supports tools, accepted `tool_choice` values, context window). L5: usage carries a cost source, `catalog` for now. L6: update the tool-calling spec. A worker streaming route comes later, for the interactive consumers. L1 and L2 are the only steps that block the first job. Decided 2026-11-15. See `lumen-changes.md`.

### 58. A task's recipe can name a fallback model
Lumen's router does no model fallback when tools are present, so the fallback lives in Lyra. A recipe can name a second model, used if the first fails after its 3 retries. A recipe with none just retries and parks the run as "model unavailable". Lumen's router is left untouched. Decided 2026-11-15. Open detail: how many retries the fallback model gets, and whether a run that switched models says so in the record (it should, as an entry).

### 59. Version one is built whole, then the timeline runs on it
Version one includes compaction (42) and both transports (45), and all of it is built before the timeline runs on Lyra. There is one checkpoint at the end, not two. I had recommended a middle checkpoint, and this overrides it. The late first end-to-end run is covered by a small two-tool test task that runs the whole stack at step 6, and by building the timeline's non-Lyra parts (GitHub fetching, the tool functions, the shared function) at any time. Decided 2026-11-15. See `first-slice.md`.

### 60. Generic adapters live in the Lyra repo, Grove-specific pieces in Lattice
The Lyra repo holds the core, the in-memory and Cloudflare adapters, the OpenAI-style model adapter, and the protocol. Lattice holds the Lumen adapter (it needs Lumen's own types and contract), the secrets adapter for tenant tokens, and the tasks, like the timeline recipe and its tools. The Lyra repo never imports from Lattice, and a check enforces it. Decided 2026-11-15.

### 61. The timeline runs on Lyra from both entry points together
The nightly worker and the Arbor generate and backfill routes both call one shared function, which runs the Lyra task. They switch over together, not one first. Decided 2026-11-15. This also means the GitHub fetching, which is duplicated between the two today, is written once.

### 62. Test-first, with happy, sad, and bad paths and the matrix rule
Every behavior gets a test for the expected flow, for expected failures, and for malformed or hostile input. A failure-mode catalog is worked through before code is written, and a script fails the build if a spec row has no test. Tests are written first and watched failing. Requested by Autumn, 2026-11-15. See `engineering-practices.md`.

### 63. The same scenario files run in-process first and over the real protocol later
So end-to-end tests exist from the first commit. The layers are unit, component, scenario, cassette, workerd, and live. Decided 2026-11-15.

### 64. Property tests, coverage-guided fuzzing, and a randomly misbehaving fake model
Property tests wherever a rule can be stated. Fuzzing for the code that takes untrusted bytes (the stream parser, frame reader, tool arguments, record loader). Requested by Autumn, 2026-11-15. The tooling is partly unconfirmed and is checked when the repository is set up (see the doc).

### 65. Local testing, with OpenCode Go for bulk and OpenRouter for fidelity
The real runtime locally, a small dev client, a live suite that uses OpenCode Go (allowance, not free) for bulk testing and OpenRouter for a small production-fidelity set, and a budget cap on every live run. Live runs record real exchanges, with keys and auth headers removed, as cassettes that CI replays free, and a test fails if a cassette holds a key-shaped string. Decided 2026-11-15.

### 66. The coding practices and one gate, with an 85% coverage floor on the core
Strict TypeScript, validated boundaries, errors as data, web-standard APIs only in the core, import and size checks, and `pnpm ci` as the definition of done. CI enforces an 85% coverage floor on the core, as a smoke alarm. The matrix rule is the real check. Decided 2026-11-15.

### 67. Two mock Lumens, kept honest by contract tests
Both options are built. **The real Lumen over a fake model:** the actual Lumen worker routes run in-process and only the network call underneath is faked, with the scripted fake model speaking OpenRouter's shape. **A standalone fake Lumen:** a small server that imitates Lumen's HTTP shape, fast and independent. One shared set of contract tests runs against both, and any difference between them fails the build, so the standalone fake cannot drift unnoticed. Both live in Lattice, next to the Lumen adapter (decision 60). The scenario files run through them as a third level. Decided 2026-11-15, with the extra work accepted. See `engineering-practices.md`.

### 69. One package with subpath exports
The core, `memory`, `cloudflare`, `openai`, and `testkit` are entry points of one package, each with its own allowed imports, enforced by a check. The testkit is public so Lattice and other projects can use it. A part can become its own package later if it needs a heavy dependency. Decided 2026-11-15. See `repository.md`.

### 71. Releases publish to npm from the start
Semver at 0.x with breaking changes allowed in minors, one CI workflow running `pnpm ci`, and a tag that gates and publishes to npm as public with built output. Publishing starts early, so the release process is exercised early. Decided 2026-11-15. The changelog and the release notes are covered by proposals 74 and 75.

### 72. The Cloudflare adapter is built on plain Durable Objects
Behind Lyra's slots, using SQLite storage, an alarm, and hibernation, which are stable core features. Cloudflare's agent tooling can be used by a consumer, and a separate adapter for it can come later. Decided 2026-11-15. This settles the question left open in decision 12.

### 73. Lyra is MIT licensed
Like Nova and Pi. Decided 2026-11-15. Lattice's own packages stay AGPL-3.0.

### 68. Name and home
`AutumnsGrove/lyra`, public, with the package `@autumnsgrove/lyra` (free on npm). Decided 2026-11-15. See `repository.md`.

### 70. The repository layout
A pnpm workspace with `packages/lyra`, `scenarios`, `examples/workers-minimal`, `scripts`, `docs`, and the CI workflows. Decided 2026-11-15.

### 74. Release notes are written by an agent in CI, adapted from Nova
On a tag push, after the gate, a script runs the Pi agent and writes the GitHub release body from the changelog section and the commit log, as equal evidence. It never blocks a release: any failure falls back to the changelog section, and then to no body. A manual dry run shows the body in the job summary without publishing. It is a TypeScript script, since Lyra has no Go, written test-first with a fake agent. It writes the release body only. `CHANGELOG.md` is still edited by hand, or by a coding agent, in a release PR, as in Nova. Decided 2026-11-15.

### 75. The release procedure follows Nova's
A version is a git tag on `main`. A release is a changelog edit, a PR titled `release: vX.Y.Z`, and a tag, in that order, with upgrade notes for anything that changes behavior for an existing caller. The tag runs the gate, builds, publishes to npm, and writes the release body. Decided 2026-11-15.

### 76. The release-notes agent keeps `bash`, like Nova's
I had recommended read-only tools (`read`, `grep`, `find`, `ls`), because the step has an API key in its environment and reads commit messages as evidence. Autumn chose to keep `bash`, as Nova does, so the agent can check a claim against the tree. Decided 2026-11-15. Cheap mitigations that keep the choice: only the owner can push tags; the key is given to the notes step and no other; the runner is thrown away after the job; and the key is one with a spend limit, which OpenCode Go's allowance already provides. This risk is accepted, not removed.

### 77. Pull requests are reviewed by the same Pi agent, set up as PR #1
Autumn will install `pi-review` from the Pi harness at the very start of development, and it will be PR #1 in the repository. It provisions the credential and identity and commits a workflow generated from `.github/pi-review.json`. Decided 2026-11-15. Note for the first steps: the repository needs an initial commit (license, README, docs) so PR #1 has something to branch from. In Nova, the review workflow and the release step share one secret (`PI_REVIEW_API_KEY`, mapped to `OPENCODE_API_KEY`), so the credential the extension provisions is also what the release step needs.

### 79. Background jobs
A `jobs` tool to list, read, wait for, and kill. Each job notifies once on exit, and the notice queues behind a pending approval. Finished jobs are remembered for the life of the run, with a capped log tail of 4 MiB, because a run can park for hours. Decided 2026-11-15. See `shell-tool.md`.

### 80. If the host is lost, a running command is not reattached in version one
On resume the tool call has no result and `bash` is not safe to repeat, so the model is told the outcome is unknown. A background job from before the loss is reported as lost. Decided 2026-11-15.

### 81. Command policy: strict by default, open by recipe
Strict is Nova's rules: allow, ask, deny, the most restrictive match wins, headless ask is deny, and an allow rule never matches a command with a shell control operator. Open is for a host declared disposable, and allows commands with a deny list for the destructive ones. A recipe picks one. A task that reads untrusted text stays strict unless the host also guards who can trigger the run, as `pi-review` does by running only same-repository pull requests. Decided 2026-11-15.

### 82. The credential scrub
Lyra's own secrets (the model keys and any token Lyra holds) are always removed from a command's environment and cannot be switched off. A recipe can hide more names, such as `GITHUB_TOKEN` for a review that does not need to push. No scrubbing by pattern, because Nova found that breaks builds. Decided 2026-11-15.

### 78. The `bash` tool and its defaults
One tool with `command`, an optional `timeout`, and an optional `run_in_background`. A 120 second deadline at which the command moves to the background, a 600 second ceiling for waiting, an output tail capped at 51,200 bytes, null stdin, a fixed working directory, and the whole process group killed when a foreground call ends. All configuration, with these as defaults. These are the defaults Nova and `pi-background` agree on. Not yet asked about directly. Decided 2026-11-15.

### 83. The command set, with an idempotency key on `start`
`start`, `prompt`, `steer`, `follow_up`, `abort`, `resume`, `get_state`, `get_messages`, `compact`, `list_sessions`, `list_pending`, and `decide_proposal`. A `start` carries an optional idempotency key, so a retried cron call does not start a second run. Nova's model, thinking, tool, session-fork, login, extension, and stateless-call commands are dropped. A new `conflict` error code is added to Nova's eight. Decided 2026-11-15.

### 84. `run_end` reasons are `done`, `parked`, and `failed`
A limit and a stop both park a run, so Nova's `exhausted` and `aborted` become `parked` with a `parked_reason` (`waiting_for_person`, `limit`, `stopped`, `stuck`, `model_unavailable`). `failed` is for a run that cannot continue. New events: `parked`, `resumed`, `fallback`, `ui_resolved`, `proposal`, and `proposal_decided`. Decided 2026-11-15.

### 85. Requests are durable, with unguessable single-use ids
Nova's `ui_request` and `ui_response` shapes, saved in the record before they are sent. The id is a 128-bit random identifier assigned by the server. A second answer to it is `conflict`, and an unknown or expired id is `not_found`. The default on timeout is deny. This is how answers cannot be forged, with no separate code. Decided 2026-11-15.

### 86. Events replay from the record
Events that come from a record entry carry its position as `seq`, so a reconnecting client gets every missed event from the record. Live deltas are not replayed. HTTP with server-sent events and WebSocket both use it. Decided 2026-11-15.

### 87. Access: a trusted caller names the tenant, a token carries it, and another tenant's session is `not_found`
Extends decision 47. Every session stores its tenant id and every command is checked against it. Decided 2026-11-15.

### 88. Who may approve: the session's owner, with no edited approvals in version one
A request can be answered by a caller whose tenant owns the session. Approving with edited arguments is not in version one: a deny with a note lets the model try again with the change you wanted. Token scopes (who may approve what) arrive when someone other than the owner uses Lyra. Decided 2026-11-15.

### 89. The shell's remaining details
A recipe names allow patterns directly in version one, and named sets (for example `tests`, `git-read`) can come later. There is no "allow for this session" answer in version one, because it only matters in interactive use and Reverie's flow is preview then confirm. The deny list for open mode is written when the shell is built. Decided 2026-11-15.

### 90. Record entries have a size cap, and oversized content is truncated with a marker
Each record entry is capped at 1 MiB by default, configurable, and always below the storage adapter's own hard limit. Cloudflare's documentation gives a 2 MB limit on a string, BLOB, or row in a Durable Object's SQLite storage (from the limits page and secondary sources, to confirm against the live page). Content that could exceed the cap (a tool result, the model's reasoning text, a proposal's evidence, a user message) is truncated before it is saved, with a marker that says how many bytes were dropped, so an entry always saves and a run never fails midway for size. The protocol's line cap drops from 8 MiB to 2 MiB, since nothing legitimate is larger, and `get_messages` is paginated. A command whose text is over the cap is `bad_request`. Decided 2026-11-15, on Autumn's go-ahead to close this gap. The 1 MiB and 2 MiB figures are my starting values, to tune.

### 91. A run pins its recipe, and a resume checks it
The record's header stores the recipe's name and version and a hash of its tool set (the tool names and their argument schemas, not the instructions' wording). On resume, the same tool-set hash means the run continues, with a `recipe_updated` entry if the version or instructions changed. A different hash, meaning a tool was added, removed, or changed, parks the run as stuck with the detail `recipe_changed`, listing the differences. A person's `resume` then continues it with the new tools, and the record notes the change. This covers the ordinary case, because deploys evict Durable Objects once or twice a day, so a long run often resumes on new code. Decided 2026-11-15.

### 92. The timeline recipe has a step limit of 40
Forty model turns, configurable in the recipe. A normal day takes well under that, so it catches a looping run. It matters because the timeline spends the Wanderer's own OpenRouter key. No cost cap yet, because Lumen only estimates cost from the catalog. These are starting values chosen without data, and they should be tuned after the first real runs. Decided 2026-11-15. Settles the suggestion left open in decision 10.

### 93. The Lyra repository gets its own `AGENTS.md` in its first commits
A guide for people and agents working in the repository, built from Nova's and from `engineering-practices.md`: the test-first rules, the repo map, the hard rules, and the definition of done. `pi-review` reads `AGENTS.md` from the base commit, so it should exist when PR #1 lands. The draft is in `agents-guide.md`, kept as the record once it was applied. Decided 2026-11-15.

### 94. The name is claimed in Grove
A Lyra entry in `docs/philosophy/grove-naming.md` (Operations), `GroveLyra` as the internal name, the GroveTerm manifest regenerated, and `lyra` reserved in the username blocklist. Done in the same pull request as the plan, on Autumn's instruction. One tradeoff is on record: Lyra is also a fairly common given name, so reserving it stops a Wanderer named Lyra from claiming `lyra.grove.place`. It is one line in `domain-blocklist.json` to undo. Decided 2026-11-15.

What was changed: the entry in `grove-naming.md`, a row in its ecosystem table and its Internal Names table, a regenerated `grove-term-manifest.json`, one `grove_service` entry in `libs/engine/src/lib/data/domain-blocklist.json` (category `internal_services`), and a test written first and watched failing. Two things found along the way. Most Grove infrastructure names are not reserved at all (`lumen`, `warden`, and `zephyr` are absent, `mycelium` is reserved, and `moss` is held as future-reserved), so this is a choice and not the norm. And the manifest generator lets the last entry in the naming doc (Blazes) absorb the document's footer, so its "see also" list comes from the footer text: it pointed at `foliage` and `prism` from the old footer, and now points at `lyra`. Neither link means anything. That is a bug in the generator and was left alone.

### 95. How the repository starts
One pnpm workspace, one package at `packages/lyra`, and only the core entry point exists: the memory, Cloudflare, OpenAI, and testkit entry points are added with the adapter that needs each one, so the exports map never promises a module that is not there. TypeScript 7 strict (no `any`, no casts on outside data), Vitest 5 for tests, Prettier with the same options as Lattice, and a Node floor of 22.19 from `.nvmrc` and `engines`. The gate from decision 66 is one command, `pnpm run ci` (decision 98 says why the `run` is there), and `.github/workflows/ci.yml` runs exactly that command on every pull request and on `main`, so the two cannot drift. The check scripts in `scripts/` are plain Node ESM with no dependencies of their own, so the gate has nothing to install before it can judge the package.

The release workflow is not built yet. The order is the gate, then the release workflow and its notes script (decision 71), then the `pi-review` install (decision 77), then step 1 of the first slice. `CHANGELOG.md` starts with an `[Unreleased]` section and nothing else, because nothing is published. Decided and built 2026-11-15.

Prettier checks the code, the configuration, and the files written here, but not `docs/`: the planning record is kept verbatim so it can be compared with the Lattice copy, and prettier rewrites markdown emphasis, which turned a path like `docs/agents/*` into `docs/agents/_` when it was tried. The docs get a careful read, not a formatter. One generated file is skipped for the same reason: `.github/pi-review.json` is written by pi-review's own serializer with two-space indentation and expanded arrays, and it is regenerated from the Pi harness, so formatting it would be undone by the next run.

### 96. Pre-written spec rows are listed as unbuilt, not exempted
The matrix rule (decision 62) fails a row without a test. Two areas were specified during planning before any code existed: `protocol.md` (28 rows) and `run-record.md` (9 rows). Deleting them would throw away the design record, and treating them as tested would be a lie, so `scripts/unbuilt-rows.json` names them with the step of the first slice that builds each area. `matrixcheck` fails if a listed ID is not a real row, if a listed ID already has a test (so the entry must be removed in the same change), or if a row is neither tested nor listed. The list only shrinks. Decided 2026-11-15.

### 97. The core stays honestly empty until step 1
The first commit is the plan, the license, the README, and `AGENTS.md`; the second is the gate and its check scripts (decision 71). `packages/lyra/src/index.ts` exports nothing yet, on purpose: coverage reports an empty file, the gate passes, and step 1 starts from a failing test rather than from a placeholder that would have to be deleted. Every check in `scripts/` was run against a deliberate violation before it was trusted: a `node:*` import, an import from Lattice, an undeclared dependency, a row with no test, a test citing an unknown row, and a package over budget each failed for the right reason. Decided 2026-11-15.

### 98. The gate is `pnpm run ci`, not `pnpm ci`
pnpm reserves `ci` for an install command and answers `ERR_PNPM_CI_NOT_IMPLEMENTED` to it, so the script named `ci` in `package.json` has to be called through `pnpm run ci`. Every document in `docs/` still says `pnpm ci`, and that is the name of the gate; this repository's invocation adds `run` because it has to. `AGENTS.md` and the CI workflow both say `pnpm run ci`, and the script runs the same steps either way. Found while running the gate for the first time, 2026-11-15.

### 99. Releases publish with npm trusted publishing, and carry provenance
Settles the last item under the release process (decisions 71 and 72). The tag job publishes over OIDC from GitHub Actions (`id-token: write`) with `npm publish --provenance --access public`, and the repository holds no `NPM_TOKEN` at all. The attraction is that the workflow which can push a tag is already the only thing that may publish, so a long-lived token adds a secret that can leak while a short-lived identity does the same job, and the attestation ties the tarball to this repository and this commit. The cost is one setup step in the npm UI, where `AutumnsGrove/lyra` and `release.yml` are configured as the trusted publisher for `@autumnsgrove/lyra`, and a publish attempted from any other workflow fails rather than quietly succeeding. Decided 2026-11-16.

### 100. A follow-up on a finished run continues the conversation
Extends decision 27. A `follow_up` that arrives when nothing is running appends the user message and starts a run in the same session: the same session id, the same record, one continuous conversation, ending in its own `run_end`. It is not refused, and it is not held back for a person to release. That makes `follow_up` and `prompt` agree in the idle case, which is the point: `prompt` already starts a run in an existing session and answers `busy` while one is live (decision 46 and `protocol.md`), so the only thing `follow_up` adds is waiting for the end instead of being told `busy`. A caller that has just watched a run finish is exactly when a follow-up is most likely, so refusing it would push ordinary use onto a second command for no gain. The record is the conversation either way, so a resume or a viewer sees one thread. Decided 2026-11-16.

### 101. The Cloudflare test tooling, read from the current docs
Settles the flag in `engineering-practices.md`, and it moves in one direction: the package is `@cloudflare/vitest-plugin`, not `@cloudflare/vitest-pool-workers`. The rename happened on 2026-08-19 with the v1 release, the configuration API did not change (`cloudflareTest()`, a Vite plugin), and version 1.8.3 was current when this was checked, with `vitest` as a peer at `^4.1.0 || ^5.0.0`, so the repository's Vitest 5 needs no change and the older "check which one it is at install" note is answered. The helpers the resume tests need all exist: `evictDurableObject(stub, { webSockets: "close" | "hibernate" })`, `evictAllDurableObjects()`, `runInDurableObject()`, `runDurableObjectAlarm()` (which fires a scheduled alarm immediately rather than waiting), `listDurableObjectIds`, and `adminSecretsStore`.

Four of Cloudflare's documented known issues shape the workerd suite when it arrives at step 4. **V8 coverage does not work in workerd**, because `node:inspector` is a stub, so that suite needs Istanbul or no coverage; the 85% floor therefore stays on the Node run, which is where the core lives anyway. **WebSockets with Durable Objects are not supported under per-file storage isolation**, so those tests run with `--max-workers=1 --no-isolate`; that matters from step 8, and it also means shared storage in exactly those files. **Fake timers do not apply to the KV, R2 and cache simulators** (Lyra uses none of them). **`import()` does not work inside a Durable Object handler or `exports.default.fetch()`**, so tests import and call handlers directly. One more, not a known issue but a trap: the plugin injects `nodejs_compat` by default, so a `node:*` import would pass in a workerd test and fail to deploy; `scripts/importcheck` is the guard for the core, and it does not cover test files, so the workerd suite must not become the place a Node dependency hides. Decided 2026-11-16.

### 102. The 2 MB row limit is confirmed, and Cloudflare's page disagrees with itself
The live limits page (last updated 2026-10-29) gives 2 MB for a string, a BLOB or a table row, and 2 MB for a key and value combined. The markdown copies of the same page give 8 MB for both, which is either a stale revision or a bug in how the page is mirrored, and it is noted rather than resolved. Decision 90's 1 MiB cap sits below the lower of the two, so the record's 1 MiB figure stands and nothing changes. What step 4 owes is the check itself: save a full 1 MiB entry to a real Durable Object's SQLite storage and read it back, which turns a documented number into a fact. Decided 2026-11-16.

### 103. What the planning record still leaves open, on purpose
Two questions the first slice carried were answered in `decisions.md` and the documents were never updated: the repository (decisions 68 to 73, 95, 98, and the publish half in 99) and the Cloudflare foundation (decision 72, which is now backed by rereading Cloudflare's docs on 2026-11-16, in 101). Every `## Open` section that listed them now says so, in `first-slice.md`, `adapters.md`, `consumers.md`, and `repository.md`, so the questions are not reopened by accident. Three small ones were settled in the same pass: npm provenance (99), a follow-up on an idle run (100), and the Cloudflare test tooling (101).

What is left is deliberate. **Grove-side checks that only Lattice can answer:** whether GitHub access for pull requests and issues goes through Warden, how Lumen gets its provider key in the local dev stack, and whether the HawkAgent answer key is still large enough. **fast-check in workerd** remains unverified; nothing says it fails, and it is plain JavaScript, but the first property test in that suite checks it instead of assuming. **Vitiate** is unverified in the same way, and the fuzz targets are pure functions, so they stay on Node if either disappoints. **Anything written with the code:** the spec rows, as each area is built (decision 62), and the input fields each task defines when it is written. Decided 2026-11-16.

### 104. Step 0 is waived for step 1a
Autumn waived the step 0 dependency for step 1a on 2026-11-17, and `AGENTS.md` and `first-slice.md` both record step 0 (the Lumen changes in Lattice, issue #1693) as blocking step 1. The waiver is hers to make and this entry is the record of it. Why it is safe: steps 1 to 4 use fakes and never touch Lumen, so the Model slot's contract is built and tested before anything implements it, and `implementation/lattice-briefs.md` repeats that same contract for the Lumen work to land against. What it does not change: step 5's Lumen half still needs step 0 and a published Lyra, so nothing in Lattice starts earlier than it did. The waiver covers 1a; 1b needs Autumn to say so again before it starts from the merged `main`.

### 105. fast-check, as a dev dependency, for property tests and fuzz targets
The first property test (the record loader, step 1a slice 3) uses fast-check 4.10.2, pinned exactly, with plain Vitest and no connector package. That follows the call already written into `implementation/README.md`, and it settles the first half of what decision 103 left unverified: Vitiate is not adopted, so a fuzz target is a `*.fuzz.test.ts` running a high-`numRuns` property over hostile bytes, seeded from the failure-mode catalog's nasty cases, with fast-check's own seed printed on failure. It is development-only, so it needs no import allow-list entry and never reaches the published package. Whether it also runs inside workerd is still open, and the first property test in that suite answers it (decision 103). Decided 2026-11-17.

### 106. Step 0 is waived for step 1b as well
Extends decision 104 on Autumn's answer, 2026-11-17. Step 1b is the loop, its events, the scenario runner in-process and the conformance port, all against the scripted model and in-memory storage, so it has the same relationship to Lumen that 1a had: none. The Lumen work in Lattice (issue #1693) was landing while 1b was built, and this is what let the two proceed at once. What it does not change: steps 5's Lumen half still needs step 0 landed and a published Lyra, and the waiver now stops at 1b, so step 2 asks again.

### 107. The agent merges a step's pull request, on Autumn's instruction
Reverses the rule in `implementation/README.md` that says "never merge, approve, or close the PR". Autumn gave the permission on 2026-11-17, after 1a sat clean and green because she was expected to merge it by hand and neither of us said so; the rule was costing a round trip per step with nothing in return once the gate and the review are both green. What still holds: the agent merges only after `pnpm run ci` passes on the head commit and the latest review has nothing blocking and unanswered, it still addresses findings as claims to check rather than instructions, and it still never force-pushes and never pushes to `main` directly. The merge is a merge commit, as the release process (decision 75) expects, and the branch is deleted. Decided 2026-11-17.

### 108. `yaml`, as a dev dependency, for reading the scenario files
The scenario files stay YAML, as `engineering-practices.md` writes them, and `yaml` 2.9.1 is pinned exactly to read them, at the workspace root so the test in `packages/lyra/src` resolves it. It is test-only: `src/` may not import `node:fs`, so Vite hands the files over as raw text through `import.meta.glob` and this parses them, which means it needs no import allow-list entry and never reaches the published package. If the parsing ever moves out of a test, this becomes a runtime dependency and a decision of its own. Decided 2026-11-17.

### 109. The package's size ceiling is 52 KiB
Raised from 40 KiB on 2026-11-17, at step 2 slice 6, when the gzipped package reached 41.6 KiB and the gate failed. The growth is the work that was asked for and nothing else: limits, the run handle with stop/steer/follow-up, retries with a fallback, the stuck safeguard, and resume reading a record back. Splitting modules does not help, because the budget sums everything under `dist/`, and cutting scope would drop behavior the step document promises. 52 KiB leaves room for the rest of step 2 and gives step 3 (recipes, tools and argument validation) a real constraint to design against. It is still two orders of magnitude under a Worker's limit, and the gate still fails on growth, so the next raise needs a reason of its own. Decided 2026-11-17.

### 110. Step 2's numbers, and what the record gained
The values step 2 had to pick, all provisional and to be tuned after real runs: retryable model failures are retried three times with delays of 1 s, 4 s and 16 s, each a floor under the provider's own `retryAfterMs`; a model that stops without finishing gets two reminders; three failures of the same tool the same way, meaning the same name and the same first 200 characters, park the run; a wake is set 60 s ahead as each step begins; `timeMs` counts active time, never calendar time; a steer is written at the gap before the next request, not on arrival, so it can be lost when a run ends; an unanswered call that is not safe to repeat is never re-run; and the tool-set hash covers names and argument schemas but not descriptions, so rewording a tool's description does not stop a run. The record gained five backwards-compatible fields for the same step: `done: true` on a tool result, so a resume can tell an accepted finish from any other answer; a `note` entry with a `kind` a reader may skip; a `fallback` entry; a `recipe_updated` entry; and, in the header's pin, an instructions hash and one hash per tool, which is what lets a resume name the tool that moved. Every one is optional, so a record written before them still loads. Decided 2026-11-17.

### 111. Tool arguments are validated by a small, in-house JSON Schema subset
Written and decided at step 3, slice 1. A tool's `parameters` already had to be what the model is shown and
what the tool-set hash covers (decision 91), so it is also what the arguments are checked against, and it
stays plain JSON Schema rather than becoming a library's own object with a second representation to drift.
The subset is `type`, `properties`, `required`, `additionalProperties`, `enum`, `items`, `minItems`,
`maxItems`, `minLength`, `maxLength`, `minimum` and `maximum`, and nothing else. `pattern` is left out on
purpose: a regular expression written by a tool author is a denial-of-service door on a model's hostile
input. `$ref` and `oneOf` are left out because a flat schema is enough for tool arguments. A schema using
any other keyword is refused when the tool is defined, so a mistake surfaces once rather than never. The
validator is pure, caps depth at 32, errors at ten and the message at 2 KiB, and the inferred TypeScript
type is a type-level mapping of the same subset, so `execute` gets checked arguments with no cast. The
time-box from `implementation/03-recipes-and-tools.md` still stands: if this had passed 250 lines or the
fuzz target kept finding one class of bug, it would have been swapped for TypeBox or Valibot and Autumn's
word would have been needed for the new dependency. Decided 2026-11-18.

### 112. A recipe's state changes only in `apply`, and its input is saved on the task message
Written and decided at step 3, slice 3. A run's progress has to live in the record (decision 32), and a tool's in-memory state cannot be saved as a second copy without the two drifting. So a recipe has a pure `setup(input)` that returns the first message and the initial state, an `execute` that may read the state and never changes it, and an `apply(state, args, outcome)` that is the only writer. The core calls `apply` after every successful execute, and again for every saved result while rebuilding on a resume, so there is one path and the live state and the replayed state cannot disagree. An error result is never applied, and neither is a call the tool's schema refused, because neither changed anything. The task's input is saved as `details` on the `task` message, which is what lets a resume run `setup` again; an input too large for one record entry is `bad_request` at start, and a record with a recipe but no saved input fails rather than guessing. Decided 2026-11-18.

### 113. The package's size ceiling is 64 KiB
Raised from 52 KiB on 2026-11-18, at step 3 slice 3, when the gzipped package passed 53 KiB before the step was half built. The growth is that step's own work and nothing else: the JSON Schema validator, `defineTool` and typed arguments, the state and replay seam, and the record's task input. Decision 109 said the next raise needs a reason of its own, and this is it: step 3's remaining modules (handles, `finish`, `defineRecipe`, and the testkit's test recipe) are not written yet, and cutting any of them drops behavior the step document promises. Splitting files does not help because the budget sums `dist/`. 64 KiB is still far below a Worker's own limit and still fails on careless growth. If the step's number comes in close to it, the next raise is again a decision rather than a rounding. Decided 2026-11-18.

### 114. Handles are a small table inside the recipe's state, rebuilt by replay
Written and decided at step 3, slice 4. A model should never copy a long exact string, both because Lumen's scrubber may rewrite it (decision 8) and because a copied hash is a typo waiting to happen, so `core/handles.ts` mints `c1`, `pr12` and so on from a kind and a target, and resolves them back. Minting is idempotent for the same kind and canonical target, counters start at one per kind, and the same mint order rebuilds the same table, which is what makes a resumed run's handles equal to a live run's (decision 32). The table is inside the recipe's state and changes only through `apply` (decision 112). It is built on `Map` rather than a plain object on purpose: a handle is a model's input, so `__proto__` and `constructor` have to be ordinary misses. An unknown handle gets a message naming it and the valid ones, capped, which is the same self-correction a refused argument gets. Decided 2026-11-18.

### 115. `finish` takes its answer from the recipe, and a recipe is checked when it is defined
Written and decided at step 3, slice 5. `finish` is the shared tool that ends a run, so it cannot be the one to decide whether the job is done: `createFinishTool({ check })` asks the recipe's own check, in the recipe's own state, and a refusal is an ordinary error result whose message names what is missing. That makes a refused finish count toward step 2's same-failure total, so a model that cannot satisfy the check parks instead of looping, and it needs no new ending. `coverageCheck` is the shape nearly every recipe wants, and its message is sorted and capped so the same gap always reads the same way. A skip needs a non-empty reason, because a skip with no reason is a thing silently left out. `defineRecipe` refuses at definition time what could never run: a duplicate tool name, a schema the subset cannot compile, a tool called `finish` that was not made by `createFinishTool`, and limits that contradict each other. `Runtime.start` now checks a task's input against the recipe's schema and returns `bad_request` rather than starting a run that would fail on its first step, which is why `start` returns a `Result`. Decided 2026-11-18.

### 116. The test recipe is `timeline-test`, in the testkit, and a scenario may name it
Written and decided at step 3, slice 6. The real timeline belongs in Lattice (decision 60), so the recipe the machinery is tested against is generic and fake: a day of repos and commits, handles for the commits, a page built from projects and lines with vines, and a `finish` that covers every commit or records a skip. It lives in the testkit, which is published so Lattice can write its own recipe against the same shapes. A scenario file can name it with `recipe:` and give the recipe's own JSON input, and a file that gives both a recipe and inline `tools` is refused rather than letting the file say two things. `finish` is marked safe to repeat, because its check is pure: a kill between the call and its result leaves nothing that running it again could duplicate, and without that a resume of a killed `finish` would be told the outcome is unknown and ask the model for a turn the script does not have. The one record that cannot be resumed is the one killed between the header and the task message, because the input is saved on the task message; it fails and says so rather than inventing the page. Decided 2026-11-18.

### 117. The workerd suite's tooling, and how Workers types reach it
Written and decided at step 4, slice 1. `@cloudflare/vitest-plugin` 1.8.5, `wrangler` 4.165.0 and `@cloudflare/workers-types` 5.20261119.1 are pinned exactly as development-only dependencies, all three at the workspace root so the tests and the example resolve them. The plugin's peer range accepts Vitest 5, so nothing about the test runner changes. **fast-check runs inside workerd**: `CFL00`'s property went through all fifty runs, which closes the last open item in decision 103 and means property tests can live in either suite. The Workers globals do not reach the core's program. `"types"` only resolves packages under the type roots, and neither Cloudflare package is under `@types`, so `tsconfig.workers.json` includes the two declaration files as program roots instead, and the root program keeps `types: []` and its own `platform.d.ts`. That is deliberate: the core's set of platform globals is a forcing function (a name it has not declared fails the typecheck), and adding Workers globals to it would let a Node-only or Workers-only name through unnoticed. The production adapter declares the small structural surface it uses instead of taking `DurableObjectStorage` from a global, so the library build still compiles with no platform types at all. Decided 2026-11-18.

### 118. A full 1 MiB entry saves to a real Durable Object, so decision 102 is confirmed
Checked at step 4, slice 2, in workerd against Miniflare's real SQLite: a single line of exactly 1,048,576 bytes saves through the adapter and reads back byte for byte, and the next append takes the next `seq`. The adapter's own limit defaults to the record's 1 MiB cap and refuses a larger line with `bad_request` before SQLite sees it, so the documented 2 MB row limit is never reached from here, whichever of Cloudflare's two numbers (2 MB on the live page, 8 MB in its markdown copies) is right. Decision 90's cap stands unchanged. Decided 2026-11-18, the check decision 102 asked for.

### 119. The package ceiling is 68 KiB, and the example Worker has its own
Raised from 64 KiB at step 4 slice 6, when the package measured 66,817 B with the Cloudflare adapter in it: storage, waking, secrets and the entry point, none of them padding. 68 KiB (69,632 B) keeps the gate meaningful and leaves the next adapter to account for itself. The step also asked for the budget to be revisited now that an adapter exists, and it is now two measurements rather than one: the package sums every entry point, which is what a consumer installs, and the example Worker's `wrangler deploy --dry-run` bundle gets its own ceiling of 28 KiB, measured at 22,194 B. The bundle is the number a Worker actually pays, and the ceiling was chosen as the measurement plus about a third, enough for the core to grow before the number is a surprise rather than a limit that gets raised every step. The measurement for a directory is a `dir` entry in `scripts/budgets.json`, so the example is measured where it is built. Decided 2026-11-18.

### 120. The release script is TypeScript run by Node's type stripping, and the release PR bumps the version
Written and decided at step R, slice 1. `scripts/release-notes/` is TypeScript with no build step: the Node floor is 22.19, type stripping is on by default from 22.18, so `node scripts/release-notes/main.ts` runs as-is, and the workflow can call it without compiling first. That decides three small things. Only erasable syntax is allowed there (no `enum`, no `namespace`, no constructor parameter properties), types arrive with `import type`, and relative imports name `.ts` files, which needs `allowImportingTsExtensions` beside `noEmit`. Those live in `scripts/tsconfig.json`, which also sets `types: ["node"]` because the script uses the builtins `src/` may not, and it is part of `pnpm typecheck`, so a broken script fails the gate rather than a release. The fallback if type stripping ever fights the toolchain is to compile with `tsc` into a temporary directory in the workflow; it was not needed. The same entry settles who changes `packages/lyra/package.json`'s `version`: the release PR does, and the release job fails when the tag (minus `v`) disagrees, because a publish that disagrees with its tag is worse than a failed release. `AGENTS.md` says so in its Releasing step 3. Decided 2026-11-19.

### 121. The first publish is made by hand, and a version already on the registry is left alone
Settles the npm trusted-publishing question step R had to ask, on Autumn's answer (2026-11-19). npm has no pending publisher: the trusted-publisher settings live on a package's own page, so the package has to exist before the setting can be created, which means the very first publish cannot come from OIDC. She therefore makes it by hand from `packages/lyra` once (`npm login` with 2FA, `npm publish --access public`), and then adds the trusted publisher for `AutumnsGrove/lyra` and `release.yml`. Decision 99 stands unchanged: no token ever enters the repository, and the first publish is a copy run on her machine rather than a secret in CI. Two consequences are written into the workflow. A newly created trusted publisher expires unless a publish succeeds within two days, so it is added when a release is ready rather than in advance. And the publish step asks the registry first and skips with a notice when that exact version is already there, so a hand-made bootstrap publish, or a re-run of a tag whose job failed later, cannot fail a release that has already happened; publishing the same version twice is impossible and failing over it is worse than saying so. What happened the same afternoon, 2026-11-19: `0.0.0` published by hand after a one-time code, `npm trust github --repo AutumnsGrove/lyra --file release.yml --allow-publish` after another, the config showing "Pending validation" with a two-day deadline, and then `v0.1.0` published by the tag through OIDC, minutes later, which validated the config and made it permanent.

### 122. The release check is part of the notes script, and a dry run only warns
Written and decided at step R, slice 1. The release job's first step has to prove that the tag, `packages/lyra/package.json`'s version and a `CHANGELOG.md` section all agree, and that check lives in `scripts/release-notes/main.ts --check` rather than in a second script or in shell. The script already reads the changelog section and strips the tag's `v`, so a separate check would be the second copy of the same two rules and the one that drifts. Its status is its own: `1` when the release cannot proceed and `2` for a usage error, alongside the `0` and `3` the body uses. A dry run prints the same disagreements as warnings and returns `0`, because a rehearsal is exactly for a version the changelog may not have caught up with yet, and a rehearsal that refuses to run is a rehearsal nobody runs. A tag push is strict: the job stops before the build and the publish. Decided 2026-11-19.

### 123. The package ceiling is 84 KiB, for the OpenAI-style adapter
Step 5's first half added the `openai` entry point: the stream parser, the request builder, the error mapping and the slot, plus the fake model server in the testkit. That is 13.6 KiB gzipped of real code and tests, so the package went from 66.8 KiB to 80.4 KiB and its 68 KiB ceiling (decision 119) could not hold it. Raised to 84 KiB (86,016 B), which leaves about 5.5 KiB for the rest of step 5 (presets and cassette replay) before it has to be looked at again. Nothing in the adapter is padding: the parser is the hostile-input surface and the error mapping is what step 2 retries on. If the second half does not fit, the answer is to look at what the package ships rather than to raise the number again quietly. Decided 2026-11-19.

### 124. A duplicate tool-call id is renamed, and a missing one is `call_<n>`
Some providers send two calls with one id, and some send a call whose id never arrives. The core requires unique ids, because the loop pairs a tool result to its call by id, so a reply with two would be refused by `decodeReply` and cost a whole turn. The parser therefore keeps the first call's id, reserves any id that belongs to exactly one call so a synthetic one cannot take its place, and gives every other call `call_<position>`. The rule is positional, so the same stream produces the same ids on a resume. The step document already settled the synthetic name; this settles what happens when the id is duplicated rather than absent. Decided 2026-11-19.

### 125. `platform.d.ts` grows the model adapters' slice of `fetch`
The library builds with `types: []`, and `platform.d.ts` is where the web surface the code may use is declared, on purpose: a missing name fails the typecheck. The OpenAI adapter needs `fetch`, `Response` (status, ok, headers, body, text, json), `Headers`, `ReadableStream` (construct, getReader/read/cancel, and a source's start and cancel) and `TextDecoder`'s `{ stream: true }`, so those are declared, only as far as is used. All of it is web-standard on Workers and Node; nothing is a dependency. The workerd program does not see this file (it takes its globals from the Workers types), which is why the testkit's fetch type is written out in the testkit instead of named from here. Decided 2026-11-19.

### 126. A provider status maps to Nova's codes, and a stop is not a failure
Step 2's retries read `retryable`, so the mapping has to be right and has to use the closed set of codes decision 83 settled: 400 and 422 are `bad_request`, 401 and 403 `permission_denied`, 404 `not_found`, 408 `timeout`, 409 `conflict`, 429 `busy`, and 500, 502, 503 and 504 `provider_error`; anything else is `provider_error` and is not retried, because a status nobody expected is not a reason to try again. 408, 429 and the 5xx family are retryable and the rest are not. A `Retry-After` header, in seconds or as an HTTP date, becomes `retryAfterMs` and is capped at five minutes, because a provider cannot ask for more of a person's time than that. A call a person stopped comes back as `timeout` with `retryable: false`: the codes have no `cancelled`, and the loop reads the signal before believing any error, so this only has to be honest rather than retried. No message carries the key: every one is built here and scrubbed of the secret before it is returned. A 400 saying the context is too long needs nothing of its own yet; step 7 reads `contextWindow` for that rather than parsing the provider's wording. Decided 2026-11-19.

### 127. There is no per-model quirks table
The step document asked for a small table of what each model accepts: which `tool_choice` values, and whether a cached prefix needs a marker. The core has no way to ask for either, so the adapter never sends `tool_choice` and never inserts a cache marker, and a table of accepted values would be dead code with nothing to test. OpenCode Go's docs also now say that every text model works through every API with the console translating, so refusing a model by dialect would block models that work. The table arrives with the first model that needs something written down, and that entry gets a row and a test in the same change. Decided 2026-11-19.

### 128. The package ceiling is 88 KiB, and a cassette is a JSON file of exchanges
The rest of step 5's first half — the seeded misbehaving model, cassettes and their replay, and the two provider presets — came to 5.4 KiB gzipped, which used up the headroom decision 123 left and then 270 B more. Raised to 88 KiB (90,112 B), which leaves about 3.8 KiB, and nothing on the list adds package code after this: the live suite and its recorder live in `packages/lyra/live/`, outside `src/`, and are never published. The cassette format is settled here too, because a file people commit is a decision: JSON with `_note` and an ordered `exchanges` list, each holding `request` (url, method, headers, body) and `response` (status, headers, body), with auth headers dropped and key-shaped strings refused at record time. Order plus a body match is what lets a retried turn replay its own recording; a request with no exchange fails loudly rather than reaching the network, because a test that quietly spent money would pass for the wrong reason. Decided 2026-11-19.

### 129. The package ceiling is 176 KiB, doubled, for the protocol and its client
Autumn's call (2026-11-21): rather than raise the ceiling a slice at a time through step 6, double it once to 176 KiB (180,224 B). Step 6 adds the protocol envelope and line reader (already in, 1.2 KiB of headroom left at 88 KiB), then command validation, the event projection, the session, the HTTP surface, the Durable Object host and the dev client, and steps 7 and 8 build on it. The number is a guard against drift, not a target: `budget` still runs in the gate on every change, and the note "lower it as the modules settle" stands. What doubling buys is one decision instead of four, and no slice that has to cut scope to fit a ceiling picked before its code existed. Decided 2026-11-21.

## Not discussed yet

Nothing. The two questions the first slice carried are closed in 103, and what remains is writing rather than deciding: the spec rows for each area (a row table with IDs, written as each is built, decision 62), and the exact fields of each task's input, which each task defines when it is written.

### 130. The event projection is a function of the whole record, and it shares the live loop's arithmetic
Written and decided at step 6, slice 2. A client that reconnects reads its history from the record (decision 86), so the projection has to be pure and stable: `projectEvents` takes a record and a session, walks the active path, and gives the same events with the same `seq` every time. An entry's position in the path is its `seq`, which is the position storage appended it at while the record is a straight line; every event from one entry shares it, so a client that resumes from a `seq` never gets half of an entry. Three small choices follow. A `resumed` status projects to both `resumed` and `run_start`, because CMD07 promises a new segment and the protocol's own event says the run came back. The turn count and the usage total carry across a segment and a `run_end` reports the run rather than the segment, because that is what a limit and a resume count against, so those two rules were moved out of `run.ts` into `core/usage.ts` and `core/events.ts` (`createUsageTotal` and `parkedReasonOf`) and both the live loop and the replay call them: one copy, and a replayed `run_end` cannot disagree with the one a watcher saw. A tool result names its tool by looking its call up in the path, and a call that is not there is named with the empty string rather than a guess. A user message, a changed pin and a note are in the record but are not protocol events. Decided 2026-11-21.

### 131. A session is one record with one run id, and the record is where its events come from
Written and decided at step 6, slice 3. The runtime's resume refuses a record whose header names another run, and the header is written once, so a session cannot honestly hold several run ids on one record. A session is therefore one record and one run id: a `follow_up` or a `prompt` with nothing running continues that run as a new segment (a `resumed` status, the person's message labelled `follow_up`, a new `run_start`, its own `run_end`), and a `resume` does the same for a parked one. Decision 44's "many runs" is this: one conversation that goes on, with segments a client can see. To make that possible `resume` gained a `followUp` (row `RSM08`): a person's resume of a `done`, `failed` or parked record carrying a message continues it, while a wake never does, and an ending already on the record no longer answers a person who is asking for more. The session answers `conflict` rather than inventing a second way to do something: `start` into a session with a record is `conflict` unless the key, task and input match; `steer` or `abort` with nothing running is `conflict`; `prompt` without `queue`, and `resume`, during a run are `busy`. Events are read from the record: after each live write the session re-reads and projects it, so a client gets exactly what a reconnect would replay, with the same `seq` and order, and only `retry` and `tool_start` travel live alone. That re-reads the whole record per write, which is the simple version and is noted as a loose end; the alternative, tracking `seq` in the live events, would be a second source of truth for what the record says. `get_state` answers `{session, run, state, parked?, turns, usage, queue, pending}` with `run: null` and `state: "idle"` before anything has started, and `pending` is always zero until approvals exist. `get_messages` answers `{session, run, entries, cursor}`: a page is capped in entries (50 by default) and in bytes (the entry cap, so a reply fits one line), the cursor is the last entry's id, and an `entry` or `cursor` naming nothing in the branch is `bad_request`. Decided 2026-11-21.

### 132. The HTTP surface is one handler, and refusals never repeat what a host said
Written and decided at step 6, slice 4. `createHttpHandler(host, options)` is a web-standard `(Request) => Promise<Response>` with a `SessionHost` seam (`open({tenant, session?, key?})`), so the Durable Object host (slice 5), `wrangler dev` and a test drive the same routes: `POST /v1/commands`, `GET /v1/events`, `GET /v1/state`, `POST /v1/ui_response` (unsupported until approvals), and `not_found` for anything else. Five smaller choices. A request body holds exactly one frame, read with the line reader under a byte cap, and a body over the cap is refused while it is being read rather than after. A refusal that has a command behind it keeps that command's `id` and name (read off the raw frame before validation), so a client can pair it; a refusal with no command behind it — no token, a wrong version, a missing route — is a frame with empty id and name, because the body is always a frame. A `not_found` from the host is never passed through word for word: a keyed session's id is derived from `<tenant>:<key>`, so a host's message could tell another tenant what it guessed, and the handler replaces it with "there is no such session". `get_state` over HTTP needs a session query parameter or command field, which is why the command's own `session` is optional only for the WebSocket (step 8), where the connection is the session. `createTokenDoor(tokens)` is the public door: a tenant-to-token map, compared by SHA-256 digest with no early exit so a wrong token costs the same wherever it differs, and a missing or wrong token is `permission_denied` 403 with no hint. The event stream enforces decision 86's cap on what is queued for one client (`controller.desiredSize`, 1024 by default) and closes it when it is passed; a replay arrives in one burst, so a cap smaller than the record drops even a client that is reading, which is why the reconnect test uses the default cap while the drop test sets one. What it costs: the platform declarations grew a `Request`, a `URL` and the stream's `desiredSize`, as decision 125's rule says they must. Decided 2026-11-21.
