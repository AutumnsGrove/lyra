# Changelog

All notable changes to Lyra are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Lyra is `0.x`, a minor bump carries
new API and any breaking change, and a patch bump is fixes only.

## [Unreleased]

### Added

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

- `docs/implementation/`: the shared rules for building (branches, commits, one pull request per
  step with `pi-review` addressed, when to stop and ask) and one document per step, R and 1 to 8,
  plus briefs for the three steps that live in Lattice. They add no decisions.

### Changed

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
