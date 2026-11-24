---
title: "The parallel tool calls slice"
status: planning
category: features
---

# The parallel tool calls slice

Last updated: 2026-11-24. Read [`README.md`](README.md) first. Branch: `feat/parallel-tool-calls`, from a
`main` with the approvals slice (A) and step 8 merged. Builds decision 154 and issue #67.

`first-slice.md` does not mention parallel calls, so this slice has no step number, the way the approvals
slice took a letter. It is also the one slice whose "Done when" in the issue includes a measurement in the
playground (#60), which does not exist yet: that half is written down as unfinished rather than skipped
silently (see the bottom of this document).

Read: `docs/core-loop.md` ("The loop" and "Parallel tool calls", which owns the rows), issue #67 and the
decision comment on it, `docs/decisions.md` 24, 44, 141 and 154, `packages/lyra/src/core/execute-tools.ts`,
`docs/recipes-and-tools.md` (the tool shape and the recipe), and `docs/approvals.md` for what an ask does
to a batch.

## Goal and done when

**A reply whose tools say it is safe runs them at the same time, and the record is the one a serial run
would have saved.**

Concretely:

- a tool opts in with `parallel: true`, and `defineTool` refuses the flag on a tool with an `apply` (TOL13);
- a run of consecutive eligible calls is dispatched together, its results are saved and announced in call
  order whatever order they finished in (LOOP17), and `apply` still runs in call order;
- a tool with an `apply`, or whose policy asks, or that never opted in, is a barrier (LOOP22);
- a failure, a throw and a deadline are one call's result inside a group, not the group's (LOOP18, LOOP20);
- a stop during a group answers every call of it and leaves no timer waiting (LOOP19);
- a question inside a group saves the calls either side of it around the request and parks once (LOOP21);
- the cap is `maxParallelCalls` on the recipe, four by default, chunks in call order, and a value that is
  not a positive whole number falls back to the default while `defineRecipe` refuses it (LOOP23, RCP08);
- **the property:** any script of grouped calls saves the record the same calls save one at a time
  (LOOP24), and the existing kill matrix runs over groups (RSM05);
- five scenario files run at all four levels (SCN04, SCN05, the socket suite): a group that finishes out of
  order, a failure inside a group, a stop inside a group, a group larger than the cap, and a question
  inside a group.

## Slices

**Slice 1: the flag and the rule.** `Tool.parallel`, `DefineToolOptions.parallel`, the `apply` refusal in
`defineTool` (TOL13), and `canRunTogether` in `execute-tools.ts`, which is the one place the eligibility
rule lives so the scheduler and a test cannot disagree.

**Slice 2: the executor.** `executeTools` takes `concurrency`, prepares a chunk, starts every call in it,
awaits the outcomes and saves them in call order, and reports whether a call asked. A chunk's second
question is answered with an error result rather than overwriting the first (LOOP17 to LOOP21).

**Slice 3: the scheduler and the cap.** `RunConfig.maxParallelCalls` and `DEFAULT_MAX_PARALLEL_CALLS` (four),
`Recipe.maxParallelCalls` and its refusal in `defineRecipe` (RCP08), the pass-through in `runtime.ts`, and
the grouping in `runBatch`: consecutive eligible calls go to the executor as one group, and everything else
is a barrier (LOOP22, LOOP23).

**Slice 4: the proof.** The property (LOOP24), the kill matrix's generator turned into groups (RSM05), the
testkit's `parallel` option, and the scenario vocabulary's `parallel`, `max_parallel_calls` and `ask`
behavior, so a scenario file can describe a group.

**Slice 5: the wrap-up.** The five scenario files, the rows in `core-loop.md` and `recipes-and-tools.md`,
decision 154, this document, the README's status, `AGENTS.md`, `CHANGELOG.md` and `notes.md`.

## Settled here

Autumn's comment on #67 settled the shape on 2026-11-24 (pure reads only: policy `allow` and no `apply`),
and decision 154 records it with the reasons. What this document adds:

- **The flag stays an opt-in, on top of that rule.** "Reads" is not the same as "safe beside another
  call": a read can hit someone else's rate limit, so a recipe says which of its reads may be fired
  together rather than the core inferring it.
- **A group is a chunk of consecutive calls, not a sliding window.** The issue says "up to a cap"; chunks
  keep the record identical for a given script, which is what the property test compares.
- **The second question in a chunk is answered, not dropped.** `runBatch`'s `waitingRequest` is one slot,
  and a second request would overwrite the first. The call is told so as an error result, so the record
  stays paired and the model can ask again after the person answers.
- **The killed group is resumed one call at a time.** A resume answers the last reply's unanswered calls
  individually rather than re-forming the group. It is slower for one batch and it keeps the resume path
  the one step 2 tested; nothing in a group may change anything, so the only cost is time.
- **The scenario vocabulary grew by one behavior and one field.** `ask` (with a `question`) says the call's
  result is a question, and `max_parallel_calls` sets the cap, because two of the issue's five scenario
  cases cannot be written without them. The protocol spells that event `ui_request` where the core says
  `request`, so the question scenario pins the order in the record rather than in the events.

## Unfinished, and why

- **The playground measurement** (#67's last "Done when") cannot be done yet: #60 does not exist. When it
  does, the same scenario files run against it and the comparison is a wall-clock number for one group and
  the same calls serially. Nothing in this slice blocks that.
- **The issue asks for seven scenario cases; five are files.** "An opted-in call between two barriers" and
  "a group larger than the cap" are both pinned in-process (LOOP22, LOOP23) and one of them is also a
  scenario file (the cap). The barrier case has no scenario file because the record it would produce is
  the one a serial run produces, so a file would assert only that a run with mixed tools still works; the
  in-process test asserts the thing that differs, which is when each call started.
- **A tool with an `apply` in a group is not supported at all**, by design (decision 154). The door for it
  is a later decision, after the pure-read version has run in the playground.
