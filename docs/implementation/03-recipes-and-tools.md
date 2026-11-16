---
title: "Step 3: recipes and tools"
status: planning
category: features
---

# Step 3: recipes and tools

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-03-recipes-and-tools`, from a `main` with step 2 merged. Builds decisions 5, 6, 8, 21, 24, 25, 32, 40 (its "current state" hook is left for step 7), and the tool side of 62 to 64. After this step a *task* is a first-class thing: instructions, tools, limits, and what counts as done, with tools that own anything exact and reject bad requests so the model corrects itself.

Read: `docs/overview.md` ("The words"), `docs/timeline-first-job.md` (the tool table and "handles, not raw ids", which this step builds the generic machinery for), `docs/run-record.md` ("where progress lives", decision 32), `docs/limits-and-interruptions.md` (resume, the idempotent call key), `docs/implementation/notes.md`, and step 2's `RunDefinition`, `ToolOutcome` and resume code.

## Goal and done when

From `first-slice.md`: **a fake-model test where a bad repo name is rejected by a tool, corrected, and the run finishes.** For this step:

- a `Recipe` defines a task, and `RunDefinition` from step 2 becomes (or is derived from) it, with no change in behavior for step 2's tests;
- tool arguments are validated against the tool's schema before the tool runs, and a failure goes back to the model as an error result that says exactly what was wrong;
- a tool can hand the model short **handles** (`c1`, `pr12`, `i34`) and resolve them back, and the handle map is rebuilt exactly on resume;
- a tool's working state (the half-built page) is rebuilt on resume from the saved results alone;
- a generic `finish` tool enforces the task's done-check, with a coverage helper, and refuses with a message that lists what is missing;
- a test recipe in the testkit exercises all of it, with the scenario from `engineering-practices.md` passing;
- fuzz targets cover argument decoding and validation.

## Out of scope

The real timeline recipe and its tools (they live in Lattice, step 9), `search_past_days`, "ask a human" (approvals are a later slice), compaction's "current state" hook (step 7, though leave `Tool` able to grow it), any tool that touches the network, a shell.

## Settled here

**Validation: a small JSON Schema subset, written in-house.** This is the call the planning record left open ("which schema library", `engineering-practices.md`). The reasoning: a tool's `parameters` is one piece of data that does three jobs. It is what the model is shown, it is what the tool-set hash covers (decision 91), and it is what the arguments are checked against. A library that keeps a second representation drifts from the first. A hand-written validator over plain JSON Schema keeps one source of truth, adds no dependency, and is easy to fuzz. Supported keywords, and nothing else: `type` (`object`, `string`, `number`, `integer`, `boolean`, `array`, `null`), `properties`, `required`, `additionalProperties` (unknown keys are rejected by default, with the allowed names listed in the error, which is what lets a model fix itself), `enum`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `minimum`, `maximum`. **No `pattern` (a regex from a tool author is a denial-of-service door), no `$ref`, no `oneOf`.** A schema using an unsupported keyword is rejected when the tool is defined, not silently ignored. Depth is capped (32) and so is the number of errors reported (10) and the length of each message.
Time-box the exercise: if the subset validator passes 250 lines of production code or the fuzz target keeps finding the same class of bug, stop, say so, and propose TypeBox or Valibot to Autumn with its gzipped size from `pnpm budget`. That would be a new allow-list entry and a decision, so it is hers to approve.

**Error text the model sees.** Stable and specific, capped at 2 KiB: `invalid arguments: arguments.repo: expected string, got number; arguments.extra: not allowed (allowed: repo, text)`. A validation failure is an error result with code `bad_request` in `details`, never an exception. The tool does not run.

**Typed arguments without casts.** Make `defineTool` infer the argument type from the schema, using a type-level mapping of the same subset (the schema is written `as const`). The validator's return type is that inferred type, so `execute` gets typed arguments and no cast is needed. If the type-level work gets heavy, the fallback is typed accessors in `core/args.ts` (`requireString(args, "repo")`). Either way, no `any` and no cast on outside data.

**Where state lives, and how it comes back** (decision 32). This is the design that makes "replaying saved tool results rebuilds the state" true by construction:

- A recipe has a pure, deterministic `setup(input)` that returns the first user message and the initial state `S` (for the timeline: the day's data rendered with handles, and the empty page).
- A tool's `execute(args, ctx)` may **read** `ctx.state` but never mutates it. It returns an outcome whose `details` carry everything the effect needs.
- A tool may have `apply(state, args, outcome)`, the only place state changes. **The core calls `apply` after every successful execute during a live run and again for each saved tool message during replay.** One code path, so live and replayed state cannot diverge.
- On resume the core calls `setup(input)` and then replays each saved call and result in order through `apply`, without running `execute`.
- For `setup` to be re-run, the task's `input` must be in the record. Save it as `details` on the `user_message` labelled `task` (subject to the entry cap; a task whose input does not fit is `bad_request` at start, which is the "very large day" limit of decision 6 made explicit).
- `ctx.callKey` (step 2) lets a tool make a repeat harmless: `add_line` with a key already in state returns the existing line, so it can be marked `safeToRepeat`.

**Handles** (decision 8). `core/handles.ts`: a `HandleTable` with `mint(kind, target)` (idempotent for the same canonical target, counters per kind starting at 1, so `c1`, `c2`, `pr1`), `resolve(handle)`, and a listing for error messages. It lives inside the recipe's state, so replay rebuilds it. A tool that is given an unknown handle returns an error naming the handle and the valid ones, capped. Properties worth stating and testing: minting is deterministic for a given input order; replaying the saved results rebuilds the same table; a handle never resolves to something another handle resolves to.

**`finish` and the done-check** (decision 25). `createFinishTool({ check })` replaces step 1's always-accepting stub. `check(state)` returns `{ ok: true }` or `{ ok: false, message }`. A refusal is an error result with that message, so the model goes back to work. Add `coverageCheck({ expected, covered, label })`, which builds the message "these 4 issues are not covered yet: i3, i7, i9, i12" (capped, with a count when over the cap) and accepts a `skipped: [{ handle, reason }]` argument where each reason must be non-empty and is saved. Repeated identical refusals count toward step 2's same-failure total, so a model that cannot satisfy the check parks as stuck instead of looping.

**The recipe,** extending step 2's `RunDefinition`: `{ name, version, instructions, input: <schema>, setup(input), tools, limits?, fallbackModel?, stuck?, retry? }`, built with `defineRecipe` which validates the whole thing at definition time (unique tool names, valid schemas, every `finish`-using recipe has a check). `start` validates `input` against the recipe's schema and returns `bad_request` on failure. The recipe's tool-set hash (step 2) now uses each tool's schema as defined.

**The shared pile.** Only `finish` in this step. Recipes pick tools from the pile and add their own.

## The test recipe (testkit)

`timeline-test`, in the testkit, is a stand-in for the Lattice timeline with the same shape (decision 60: the real one lives in Lattice, so this is generic and fake). Input: a list of repos and a list of commits `{ repo, sha, message }`. `setup` mints `c1..cN` for the commits and renders the day. Tools:

- `start_project({ repo })`: rejects a repo not on the day's list with the list of real ones (`engineering-practices.md`'s example), otherwise creates a project section.
- `add_line({ project, text, cites })`: every handle in `cites` must exist **and belong to that project's repo**; returns a line id; idempotent by `callKey`.
- `add_vine({ line, text })`: the line must exist.
- `mark_continuation({ day, text })`: a tool with a different error shape, to vary the cases.
- `finish`: the coverage check, every commit handle is covered by a line or skipped with a reason.

State is the page: projects, lines, vines, and a pure `renderPage(state)` used by tests to compare before and after a resume.

## Slices

**Slice 1: the validator.** `core/schema.ts` and the error formatting. Fuzz target `schema.fuzz.test.ts`: any schema-shaped and any value-shaped input either validates or returns errors, never throws, never loops, and respects the depth and error caps. Rows (prefix `SCH`, in the new `docs/recipes-and-tools.md`, linked from `overview.md`): happy for each type and keyword; sad: a missing required field, a wrong type, an out-of-range number, an enum miss; bad: unknown keys (rejected, listing the allowed), arguments that are `null`, an array, a string, deeply nested input past the cap, a thousand errors capped at ten, a schema with an unsupported keyword rejected at definition, a very long string value.

**Slice 2: typed tools and the loop's use of them.** `defineTool`, with inference. The loop validates before executing and returns the formatted error. Rows (`TOL`): an invalid call never reaches `execute`; a valid call gets typed arguments; the error result tells the model what to fix; the same invalid call three times parks as stuck (step 2's safeguard, now reachable); tool-set hash changes when a schema changes and not when a description does (this strengthens `REC08`).

**Slice 3: state, `apply`, replay.** `setup`, `ctx.state`, `apply`, and replay on resume, plus the `input` saved on the task message. Rows (`TOL`): effects come only from `apply`; the live path and replay path produce an identical state (property: for any generated call sequence, `state(live) == state(replay(record))`); a tool that tries to mutate state inside `execute` is caught by the test that compares live and replayed state (this is the rule's enforcement, so write that test to be able to fail); a repeated call with the same `callKey` changes nothing; replay never runs `execute`.

**Slice 4: handles.** `core/handles.ts`. Rows (`HND`): mint, resolve, idempotent mint, per-kind counters; unknown handle error lists valid ones; rebuilt exactly on resume; the property tests above; a hostile handle string (`c1; drop`, a 10 KiB string, `__proto__`, `constructor`) is just unknown, with no prototype pollution (use `Map`, not plain objects).

**Slice 5: `finish`, the coverage check, the recipe.** `core/finish.ts`, `core/recipe.ts`. Rows (`FIN`, `RCP`): `finish` refused until covered, with the list; skipped with a reason is accepted; skipped with an empty reason is refused; accepted `finish` ends the run `done`; a model that cannot satisfy the check parks as stuck; `defineRecipe` rejects duplicate tool names and bad schemas; `start` with invalid input is `bad_request`; input over the cap is `bad_request`; step 2's `RunDefinition` tests still pass unchanged.

**Slice 6: the test recipe and the scenarios.** The `timeline-test` recipe in the testkit, with a `renderPage`. Scenario format gains `recipe:` naming a testkit recipe and `input:` for its input (it used inline `tools:` before). Add scenarios: the bad-repo-corrected one from `engineering-practices.md` verbatim; `finish` refused then corrected; a vine on a missing line; a citation of a commit from another repo; an invalid-arguments call. Add a **resume scenario** to the step 2 harness: kill the test recipe at every append, and assert the resumed page equals the uninterrupted page, the handle table is identical, and a repeated `add_line` after resume does not duplicate (RSM extended with the recipe).

**Slice 7: wrap-up.** Update `overview.md`'s table and "The words", `timeline-first-job.md` where it says the tools are a first draft (add a pointer, do not rewrite its design), `limits-and-interruptions.md` for the done-check and call key, `run-record.md` (the task message's `details`), the README status, `AGENTS.md`, `CHANGELOG.md`, `decisions.md` (the in-house validator, the apply rule, the handle table, 104 onward).

## Cases to work through from the catalog

"Model and streaming" tool-call items that the core decodes (arguments invalid JSON, empty, `null`, an empty name, a name no tool has, two calls interleaved) were rows in step 1, so extend them with validation: confirm each now flows through the schema stage and produces the message above. "The loop": a tool that is slow, instant, throws, returns an error, returns nothing, returns an enormous result (a result over the entry cap is truncated and marked; a tool whose state depends on the truncated part must keep its `details` under the cap, as `run-record.md` says: test that a recipe violating this is caught). "The record and resume": replay rebuilds tool state exactly (the handle map, the half-built page). Untrusted data: a tool result that tries to instruct the model must not change which tool is called, and a result must never be interpreted as a handle or a command.

## Judgment calls already made

Unknown argument keys are rejected, not ignored. No `pattern`, no `$ref`, no `oneOf`. Error text is capped at 2 KiB and ten errors. State changes only in `apply`. `input` is saved on the task message. A refused `finish` is an ordinary error result. The test recipe is named `timeline-test` and is generic.

## Mechanics changed in this step

No new entry points or dependencies. The testkit grows (`timeline-test`, helpers). `docs/recipes-and-tools.md` is new, so check that `matrixcheck` sees its rows. Re-check the size budget.
