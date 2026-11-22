# Changelog

All notable changes to Lyra are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Lyra is `0.x`, a minor bump carries
new API and any breaking change, and a patch bump is fixes only.

## [Unreleased]

Lyra has a wire. `0.2.0` keepers can upgrade with `pnpm add @autumnsgrove/lyra@0.3.0` and change nothing:
every existing export behaves as it did. What is new is the protocol over HTTP, a session object over it,
and two small additions to the core the protocol needed. A record's header now carries its session's
tenant, and a record from before that field loads without it. `ResumeRequest` gained an optional
`followUp`, `RuntimeOptions` and `RunConfig` gained an optional `tenant`, and `RunHandle` gained
`pending()`, none of which an existing caller has to use.

WebSocket arrives with the same release: the same frames over a socket, with the
server's `hello` first, `since` as the replay cursor, hibernation through the
Durable Object's own `acceptWebSocket`, and `pnpm lyra --transport ws`.

Approvals and proposals arrive with the same release: a run can stop and ask a
person, wait at no cost, and carry on from the answer, and a finished run can leave
a proposal for a decision later. The seams are opt-in — `Tool.policy`, `Tool.risk`,
`ToolOutcome.ask`, `ToolOutcome.propose`, `Tool.currentState`'s neighbour
`RunConfig.canAsk`, `RunConfig.approvals`, `createProposeTool` — and a caller who
sets none of them behaves as before.

Compaction arrives with the same release: a long run summarizes its older steps
instead of failing at the model's window, and the record keeps everything. Three
more optional seams are new — `ModelSlot.contextWindow`, `Tool.currentState`, and
`RunConfig.compaction` with `RunConfig.toolResultBytes` — and `Tool` gained
`maxResultBytes` and `truncationHint`. A caller who sets none of them behaves as
before, except that a tool result is now capped at 50 KiB as the model reads it.

### Added

- `projectEvents` and `eventsAfter` in the core entry point: a record projects to the protocol's
  events, each carrying the `seq` of the entry it came from, so a client can replay a run from any
  point it last saw (rows EVT01 to EVT03 and EVT06 in `docs/protocol.md`).

- `createSession` in the core entry point: one session over a storage slot, running the protocol's commands
  (`start` with an idempotency key, `prompt`, `steer`, `follow_up`, `abort`, `resume`, `get_state`,
  `get_messages`) and publishing its events from the record, so a client that reconnects catches up
  (rows CMD01 to CMD07, CMD11, CMD12 and CMD17 to CMD19 in `docs/protocol.md`).
- `createHttpHandler` and `createTokenDoor` in the core entry point: the protocol over HTTP — one command
  per request answered as a frame with a status from its error code, server-sent events with the record's
  `seq` as the event id and `Last-Event-ID` replay, `GET /v1/state`, and a bearer-token door compared in
  constant time (rows HTP01 to HTP08, ACC01 and ACC02 in `docs/protocol.md`).
- `@autumnsgrove/lyra/cloudflare` gains the session object: `createCloudflareSession` serves the protocol
  over HTTP, resumes through its alarm, and answers a trusted caller that names its tenant;
  `createSessionWorker` is the Worker's routing, and `sessionIdFor` is the idempotent session id. A record's
  header now carries its session's tenant (row RCD10 in `docs/run-record.md`).
- Every scenario file in `scenarios/` now runs a second time over the real HTTP surface against a Durable
  Object (row SCN05 in `docs/engineering-practices.md`). `examples/workers-minimal` is a real small server
  that mounts the session object, `pnpm dev` runs it, and `pnpm lyra` is a dependency-free developer client
  for the protocol (`start`, `tail`, `steer`, `follow-up`, `abort`, `resume`, `messages`).
- Compaction: a run whose history comes too close to the model's window summarizes its older steps
  through the same Model slot, saves a `compaction` record entry, and carries on with a view built from
  that entry's pointer, so the record is never rewritten and replay still rebuilds tool state from every
  saved result (rows CMP01 to CMP22 in `docs/context-size.md`, decisions 39 to 42 and 135 to 138). A
  `compaction` event joins the protocol's events, with the entry's `seq` so a reconnect replays it.
- The protocol's `compact` command works: with nothing running it summarizes the session's record now,
  with a person's own instructions added for that one summary, and answers whether there was anything to
  cut; during a run it is `busy` (row CMD20 in `docs/protocol.md`).
- Approvals and questions: `Tool.policy` (`allow`, `ask`, `deny`) and `Tool.risk`
  (`reads`, `changes`, `dangerous`) decide per call what needs a person, and a tool
  can answer with `ToolOutcome.ask` instead of a result, so a question is the same
  mechanism as an approval (rows APR01 to APR15 in `docs/approvals.md`, decisions 34
  to 37 and 139 to 141). A call that needs an answer saves a `request` record entry
  and parks the run `waiting_for_person`; an answer is a `request_answered` entry,
  written through a session's `respond` or `POST /v1/ui_response`, and the run
  continues from it. A request's `timeoutMs` is denied by the host's alarm, and a run
  with nobody to ask (`canAsk` false) denies instead of parking.
- Proposals: `createProposeTool` saves a `proposal` entry with the task's typed
  payload and evidence and ends the run `done`; `decide_proposal` accepts or rejects
  it once, with a note (rows PRP01 to PRP06 in `docs/consumers.md`, decision 142).
- WebSocket (`GET /v1/ws?session=&since=`): the server speaks `hello` first, a
  command before the exchange is `bad_request` with the socket left open, every
  command answers what HTTP answers, and a reconnect replays the record then goes
  live with no gap and no duplicate (rows WSK01 to WSK14 in `docs/protocol.md`,
  decisions 101 and 143). Every scenario file now runs a fourth level over a socket,
  and `pnpm lyra --transport ws` drives the same commands over it.
- The protocol's `compact` neighbour `list_pending`, `decide_proposal` and
  `POST /v1/ui_response` all answer now, and the record projects `ui_request`,
  `ui_resolved`, `ui_expired`, `proposal` and `proposal_decided`
  (rows CMD08 to CMD10, EVT04 and REQ01 to REQ06 in `docs/protocol.md`).
- `Tool.currentState` shows the model the recipe's exact state after a compaction, `Tool.maxResultBytes`
  and `Tool.truncationHint` shape how a big result is cut, and `ModelSlot.contextWindow` is where a host
  says how much its model can read.

## [0.2.0] - 2026-11-21

Lyra gains its first real model adapter, and nothing existing changes. `0.1.0` keepers upgrade with
`pnpm add @autumnsgrove/lyra@0.2.0` and no code edit: the entry points, the slots, the record and the
loop behave as they did.

What is new is additive, and a `0.1.0` caller never has to touch it. The `./openai` subpath is new, and
reaching it takes a `clock` and a `SecretsSlot` (both required, as every adapter needs them) plus an
optional `fetch`. The scenario runner takes an optional `makeModel`, so a scenario can run through a
real adapter. And `testkit` exports new helpers: a fake model server, a seeded misbehaving model, and
cassette recording, replay and the key-shaped-string scan.

The one internal change is `core/system-clock.ts`, whose timer handle stopped being named `number` so
Node's timer type fits; its exported `systemClock()` and `systemIds()` are unchanged.

### Added

- `@autumnsgrove/lyra/openai`: an OpenAI-style model adapter for chat completions, which serves
  OpenRouter and OpenCode Go from one base URL, model id and secret name (decision 14). It reads its
  key from a Secrets slot on every call, streams a reply and assembles text, reasoning, tool calls,
  usage and a finish reason, and maps every failure to a `ModelError` with the right `retryable`, so
  the core's retries and parking work unchanged. A stream that ends early, a reply cut off on the token
  limit, an oversized reply, a stalled call and a stop are each handled and tested (rows OAI01 to
  OAI29 in `docs/adapters.md`).
- The testkit gains a fake model server: the same `ScriptedTurn` scripts the in-process scripted model
  reads, served as real server-sent-event bytes, with named ways to misbehave on purpose (cut stream,
  malformed JSON, a stall, 429 with and without `Retry-After`, a 500, a 200 with an error body, a
  non-JSON error, an error mid-stream, one huge chunk) and a record of every request it received
  (rows KIT09 to KIT11).
- `platform.d.ts` declares the model adapters' slice of `fetch`, `Response`, `Headers`,
  `ReadableStream` and `TextDecoder`'s streaming mode (decision 125).
- `testkit` gains a seeded misbehaving model: one script per seed of the wrong replies a real
  provider sometimes sends (truncated arguments, an unknown tool, a repeat, an empty answer, a
  reply cut off on the token limit, usage with no cost), so a whole run can be driven through bad
  behaviour and must still end exactly once with a record that loads (KIT12 and KIT13).
- The scenario runner takes a `makeModel`, so every scenario file runs a third time through the
  OpenAI-style adapter and the fake server (SCN04).
- Cassettes: `testkit` records an exchange with its auth headers dropped, replays it as a `fetch`,
  refuses a request the file has nothing for, and scans for key-shaped strings; `cassettes/` holds a
  synthetic recording from the fake server and two real ones, from a live run on 2026-11-21 (CAS01 to
  CAS03, decision 128).
- `openRouter()` and `openCodeGo()`, thin presets over the adapter (OAI30), and `pnpm test:live`: an
  opt-in suite in `packages/lyra/live/` that makes one real call with a tool through each provider
  under Lyra's own limits, skips loudly without a key, and can record a cassette with `RECORD=1`.

### Changed

- The example Worker's ceiling moves from 44 KiB to 48 KiB gzipped, for the socket
  handlers a hibernating socket needs (decision 143).
- The package's size ceiling moves from 68 KiB to 84 KiB gzipped for the OpenAI-style adapter
  (decision 123), and then to 88 KiB for the misbehaving model, cassettes and the presets (decision
  128).
- A tool result's model-facing content is capped at 50 KiB when it arrives, or at the tool's own
  `maxResultBytes`, with a marker and the tool's hint for getting the rest. The record now holds what
  the model saw rather than always the whole result, and the `tool_end` event carries the same text
  (decision 138).
- `ModelRequest` gained an optional `purpose: "compaction"`, which an adapter may ignore, so a summary
  call can be told apart from a turn (decision 136).

## [0.1.0] - 2026-11-19

This is the first release anyone should install, and there is nothing to migrate to reach it. `0.0.0`
was published only to create the package, because npm will not take a trusted publisher for a package
that does not exist yet.

### Added

- The release workflow and its notes script (step R): a `vX.Y.Z` tag runs the gate, checks that the
  tag, `packages/lyra/package.json` and `CHANGELOG.md` agree, publishes
  `@autumnsgrove/lyra` to npm over trusted publishing with provenance, and writes the GitHub release
  body from the changelog section and the commit log, with a fallback to the changelog section so a
  release never waits on the agent. A manual dispatch rehearses everything but the publish and puts
  the body in the job summary (decisions 99, 120 to 122).
- `scripts/release-notes/`, the script that writes the body, run by hand as
  `node scripts/release-notes/main.ts [flags] [previous-tag] <tag>`: no build step, a fake agent in
  its tests, every fallback path covered, a cap on the body, and a refusal to publish anything that
  looks like a key. Its rows are in `docs/release-notes.md`.
- `scripts/matrixcheck.mjs` now reads test names under `scripts/` as well, so the release script's
  rows are held to the same rule as the core's, and `scripts/tsconfig.json` joins `pnpm typecheck`.

- The planning record, moved from Lattice: the overview, the decisions, and one document per topic
  in `docs/`, with the raw research in `docs/research/`.
- `AGENTS.md`, the instructions for people and agents working here, from the draft in
  `docs/agents-guide.md`, plus a `CLAUDE.md` that points at it.
- The gate: `pnpm run ci` runs format, typecheck, build, test, fuzz, import checks, the matrix
  check, size budgets, and coverage, and `.github/workflows/ci.yml` runs the same command on every
  pull request and on `main`.
- The three check scripts the gate needs, each tried against a deliberate violation before it was
  trusted: `scripts/importcheck.mjs` (entry-point imports, web-standard core, no Lattice),
  `scripts/matrixcheck.mjs` (the matrix rule), and `scripts/budget.mjs` (gzipped size).
- `scripts/unbuilt-rows.json`, which lists the 37 spec rows written during planning that have no code
  yet, with the step that builds each area (decision 96).
- The published package `@autumnsgrove/lyra` at `0.0.0`: TypeScript strict, built to `dist`, with
  only the core entry point until an adapter needs another (decisions 69, 95).
- The core's vocabulary: `Result` with the nine stable error codes, the `Clock` and `Ids` slots, the
  Model, Storage, Secrets and Waking slot types, and the tool contract. Time, ids and logging are
  injected everywhere except `core/system-clock.ts`, and `scripts/importcheck.mjs` now fails a
  production file that reaches for the real clock, a real timer, real randomness or the console.
- `docs/core-loop.md`, the spec for the core, which grows a section and a row table per slice of
  step 1.
- `decodeReply`, the boundary every model adapter feeds: it accepts a well-formed reply, a missing
  finish reason or usage, and any extra field a provider adds, and refuses a field of the wrong type
  with `bad_request` naming it. Tool arguments stay raw text, so invalid JSON is the loop's to hand
  back rather than the decoder's to hide (decision 21).
- The record's entries (`user_message`, `assistant_message`, `tool_message`, `status`), a
  deterministic encoder, a tolerant loader and replay. A damaged line is skipped and noted, an entry
  kind this build does not know is preserved exactly as it was saved, and a record with no usable
  header is refused rather than given an invented run id (decision 31).
- `@autumnsgrove/lyra/memory`: in-memory storage, secrets, waking and counter ids, for tests and for a
  run that need not outlive the process. Storage has one shared contract
  (`src/testing/storage.contract.testing.ts`) that every adapter runs, so the Cloudflare adapter in
  step 4 is held to the same cases (decision 12).
- `@autumnsgrove/lyra/testkit`: a fake clock a test advances instead of waiting, a scripted model that
  answers by conversation position and can fail on purpose, storage that fails on the nth append, and
  tools made from data (`finish` among them). Every later step's tests are written with it, and it is
  published because Lattice and other projects use it too (decision 69).
- `runTask`, the loop: ask the model, run a reply's tool calls in order under a deadline, hand the
  results back, and end in exactly one `run_end`. The record is written as it goes, so an interruption
  loses no step (decision 20), and the events carry the record's `seq` (decision 86).
- The loop's endings: a stopped run parks as `stopped` at any of the four points a person can stop it,
  a reply cut off by the token limit has none of its calls run, a tool that throws or outstays its
  deadline becomes an error result, and a model or storage failure ends the run `failed` once, with
  `run_end` still emitted.
- A stop that lands between a tool being announced and the tool starting is no longer lost: the call sees
  the already-aborted signal instead of sleeping until its deadline, which `scenarios/abort.yaml` found.
- A run's record now keeps what the run actually wrote: an assistant turn whose call has no name or id,
  or the same id twice, loads and replays instead of vanishing (RCD08), and nothing is written into a
  record whose header could not be saved.
- Each record entry is capped at 1 MiB (or the storage adapter's own limit when that is lower). Content
  that would exceed it is cut at a character boundary with a marker in the text and a `truncated` field
  saying which field and how many bytes, so a save never fails for size; a task input too big is refused
  with `bad_request` and nothing is written (decision 90).
- A tool call the model gave no id, or a repeated id, is given one that no other call in the reply uses,
  before anything is written, so the assistant turn, its results, the conversation and the record all pair
  on the same ids. Previously the result was renamed and the turn was not, which a provider rejects and a
  resume replays.
- The conformance cases from Nova's Go tests and Pi's loop tests that applied to this loop: every event
  names the run, carries the clock's time and a `seq` that only increases; no ending leaves a timer
  waiting; and a tool that never settles is answered by its deadline rather than holding the run.
- `scenarios/`, six files that script a fake model and say what should happen, and a runner that executes
  them in-process and reports what did not match. Step 6 runs the same files over the protocol (decision
  63), so the files use the protocol's spelling where there is one.
- A hostile reply gets an answer rather than an exception: bad arguments, an empty name, a tool the run
  does not have (the error names the ones it does), the same call id twice, and a call after `finish`
  are all error results, and a tool result that tells the model what to do is stored as data and
  changes nothing.
- The record's entries are capped at 1 MiB by default (lowered to a storage adapter's own limit when
  that is smaller): content is cut to fit, with a marker and a `truncated` field, so no input of any
  size makes a save fail, and a task input over the cap is refused with nothing written (decision 90).
- A run can be bounded by steps, tokens, active time and cost, all optional and none by default. Reaching
  one parks it as `limit` with a status `detail` naming which, keeping everything done so far. A cost
  limit that a reply cannot measure stops being enforced and writes one `note` entry, rather than
  pretending it works (decisions 15, 18, 22).
- The runtime sets a wake a step ahead through the Waking slot, re-arms it each step, and cancels it when
  the run ends, so an evicted run resumes on its own and a finished one is not woken. The in-memory
  adapter records and fires wakes on demand (WAK01, WAK02).
- `createRuntime` owns the runs a process is driving: `start`, `resume`, `wake` and the handle per run.
  A wake continues only a run that was killed while running, joins a run this process already owns, and
  two alarms for the same run resume it once; a person may resume any park, with new limits (decisions
  20, 23).
- A resume checks the recipe against the header's pin: the same tools and instructions continue, a new
  version or reworded instructions are noted in a `recipe_updated` entry, and a changed tool set parks
  as `stuck` with `recipe_changed` and the tools named, until a person resumes it (decision 91).
- `runTask` can resume a record: the conversation, the turns, the usage and the active time of a run
  are read back from what it saved, the last turn's unanswered calls are answered instead of assumed
  (a call that is safe to repeat runs again; one that is not is reported as an unknown outcome), and a
  record whose tool result passed the done-check ends `done` without asking for another turn (decisions
  20, 24). The package's size ceiling moves from 40 to 52 KiB (decision 109).
- The stuck safeguard, on by default and configurable per run: a model that stops without finishing
  is reminded twice and then the run parks `stuck`, and a tool that fails the same way three times in
  a row parks it too, naming the tool. A cut-off reply counts as a failure of its own kind, and the
  `reminder` label now loads from a record (decision 25).
- A retryable model failure is retried three times with growing delays (1 s, 4 s, 16 s, with the
  provider's own `retryAfterMs` as a floor), then the recipe's fallback model if it names one, and
  otherwise the run parks `model_unavailable` instead of failing, so an outage is a pause. A
  non-retryable error still ends the run `failed` (decisions 26, 58).
- `createRun` returns a handle for a run in flight: `abort()` stops it (a second call does nothing),
  `steer(text)` redirects it at the next gap between steps, and `followUp(text)` is read where the run
  would otherwise end. Both texts are queued, never written on arrival, so a tool call and its result
  are never split; a text too big for one record entry is refused with `bad_request`, and a command after
  the run ended with `conflict` (decisions 19, 27).

- The `timeline-test` recipe in the testkit: a generic, fake day of repos and commits, with handles,
  projects, lines, vines, a continuation and a coverage-checked `finish`, plus `renderPage` and
  `renderHandles` for comparing a resumed run with an uninterrupted one. A scenario file may name it with
  `recipe:` and give its JSON `input`; a file without one keeps the inline `tools:` shape (decision 116).
- Five recipe scenarios, including the bad-repo-corrected one from `engineering-practices.md`, and
  `RSM07`, which kills the test recipe at every append and compares the resumed page and handles with the
  uninterrupted run's.
- `finish` is safe to repeat, so a run killed between its call and its result resumes instead of being
  told the outcome is unknown.
- `finish` with a done-check: `createFinishTool({ check })` takes the recipe's own answer, a refusal is
  an error result the model works from, and `coverageCheck` says `not covered yet: 4 issues (…)`,
  sorted and capped. A skip needs a reason. Repeated refusals park the run as stuck (decision 115).
- `defineRecipe`, which checks a task's input schema, its unique tool names, their schemas, and that a
  tool called `finish` really has a done-check, refusing a broken recipe at module load instead of on a
  person's first day. `runtime.start` validates a task's input against the recipe and returns
  `bad_request` instead of starting a run that cannot work, so `start` now returns a `Result`.
- `createHandleTable`: short handles (`c1`, `pr12`, `i34`) that the model cites instead of a commit
  hash or a link, with a deterministic, idempotent mint per kind, a resolve back to the real value,
  and a capped listing for the error an unknown handle gets. It lives in a recipe's state, so replay
  rebuilds it exactly (decision 114).
- A recipe's state comes back from the record: `setup(input)` makes the first message and the state,
  a tool may read `ctx.state` but only `apply` changes it, and a resume replays every saved result
  through that same `apply`, so a live run and a rebuilt one cannot drift. The task's input is saved in
  the `task` message's `details`, and one too big for a record entry is refused with `bad_request`
  before anything is written (decision 112). The size ceiling moves from 52 to 64 KiB (decision 113).
- `compileSchema` and `validateValue`: the small JSON Schema subset a tool's arguments are checked
  against (`type`, `properties`, `required`, `additionalProperties`, `enum`, `items`, `minItems`,
  `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`). A tool author's schema is refused at
  definition time if it uses anything else, and a model's arguments are refused with a specific message
  that never throws, never runs past a depth cap, and never lists more than ten errors (decision 111).
- `docs/implementation/`: the shared rules for building (branches, commits, one pull request per
  step with `pi-review` addressed, when to stop and ask) and one document per step, R and 1 to 8,
  plus briefs for the three steps that live in Lattice. They add no decisions.
- `@autumnsgrove/lyra/cloudflare`, the first adapter: `durableObjectStorage` (one row per record line in
  a Durable Object's SQLite, `seq` from a synchronous transaction, a line over the adapter's limit refused
  before SQLite sees it), `alarmWaking` (one row and one alarm per object, `scheduledWake` for the host's
  handler) and `bindingSecrets` (own string bindings only). It imports the core and the runtime's own
  modules and nothing else (decisions 72, 117).
- `pnpm test:workers`, the workerd half of the gate through `@cloudflare/vitest-plugin` 1.8.5, with
  `wrangler` 4.165.0 and `@cloudflare/workers-types` 5.20261119.1 pinned for it: the shared storage
  contract runs against real Durable Object SQLite, a full 1 MiB entry saves and reads back byte for byte
  (decision 118, closing decision 102), and a run is held, evicted and woken through its alarm at every
  append, with the resumed record, page and handles matching an uninterrupted run's. fast-check runs in
  workerd too, which closes decision 103's last open item.
- `examples/workers-minimal`, a Worker and Durable Object using the core and the adapter, built in CI with
  `wrangler deploy --dry-run` (never a deploy) and measured by the size budget at 22,194 B of 28,672 B
  (decision 119).
- The package's size ceiling moves from 64 to 68 KiB with the adapter in it (decision 119), and the budget
  now measures a built directory as well as a package.

### Changed

- The core keeps its own narrow platform declarations and the Workers globals reach only
  `tsconfig.workers.json` (decision 117). `pnpm run ci` runs the workerd suite after the Node tests, and
  the example Worker's dry-run build before the budget.
- `Runtime.start` returns a `Result<RunHandle>`, because a recipe's input schema is checked before a run
  begins and a refused input is `bad_request` with nothing written. A caller that used the handle directly
  now unwraps the result. Step 2's minimal definition still works: without an `input` schema, nothing is
  checked and the text input is unchanged.
- `ToolContext` gained `state`, and `Tool` gained `validate`, `apply` and `finish`, so a tool reads a
  recipe's state, is checked before it runs, and changes state only through `apply` (decisions 112, 115,
  116). `JsonValue` accepts a readonly array, so a schema written with `const` type-checks as JSON. A tool
  made by hand, as the testkit's fakes are, carries no schema and is not checked, which is why step 2's
  tests are unchanged.

- The planning record carries no open questions, and it gained decisions 99 to 103 in the process. The
  two the first slice listed, the repository's name, layout and release process, and whether the
  Cloudflare adapter builds on Cloudflare's agent tooling, were already decided (68 to 73, 95, 98), so
  the `## Open` sections in `first-slice.md`, `adapters.md`, `consumers.md` and `repository.md` now say
  so instead of reopening them; what stays open on purpose is decision 103.
- Releases publish over OIDC with npm trusted publishing and `--provenance`, holding no token in the
  repository (decision 99). A `follow_up` that arrives when nothing is running continues the
  conversation in the same session (decision 100). The Cloudflare test tooling is named rather than
  flagged: `@cloudflare/vitest-plugin`, renamed from `@cloudflare/vitest-pool-workers`, running on
  Miniflare and therefore workerd, with four documented issues that shape that suite (decision 101).
  The 2 MB Durable Object row limit is confirmed against the live page, which disagrees with its own
  markdown copies (decision 102).
- Prettier checks the code and the configuration, but not `docs/`, so the planning record stays as it
  was written, and not `.github/pi-review.json`, which pi-review generates with its own serializer
  (decision 95).
