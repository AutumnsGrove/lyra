---
title: "Step 7: compaction"
status: planning
category: features
---

# Step 7: compaction

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-07-compaction`, from a `main` with step 6 merged. Builds decisions 39 to 42. It will rarely fire, and it is in version one on purpose (decision 42), so a long run never has to stop at the context limit.

Read: `docs/context-size.md` (the owner), `docs/run-record.md`, `docs/limits-and-interruptions.md`, step 2's kill harness and step 3's tool state and replay (`apply`, `setup`), and `docs/lumen-changes.md` item 7 (`contextWindow` per model, which Lumen provides).

## Goal and done when

From `first-slice.md`: **a long scripted run compacts, and replay still rebuilds tool state from the full record.** Concretely:

- the loop compacts when the last request's input tokens pass the model's context window minus a reserve, and the run continues;
- the record keeps everything and gains a `compaction` entry; the model's view is built from the record;
- the cut never falls between a tool call and its result (property test);
- a run killed at every point of a compaction resumes correctly;
- `compact` works as a protocol command;
- if the first message alone exceeds the window, the run fails clearly with `input_too_large`.

## Out of scope

A different summarizer per call site beyond the recipe's one setting, streaming, token-exact counting (estimates are fine), a `contextWindow` source other than the model slot and an explicit recipe override.

## Settled here

**What the model sees** (decision 39). A view built from the record: the recipe's instructions (always the system message, so "pinned" is true by construction), then the latest compaction's summary as a user-role message, then the tool "current state" text if any tool supplies one, then the entries from the compaction's `firstKept` pointer on. The record is never rewritten, so replay is unaffected and step 3's `apply` replay still runs over **every** tool message, including those before the cut.

**The `compaction` entry:** `{ type: "compaction", summary, firstKept: <entry id>, replaces: <count>, usage, model, trigger: "auto" | "manual", instructionsHash }`. A second compaction summarizes the previous summary plus the entries between, and advances `firstKept`. It is a new entry kind, which older readers skip.

**The trigger** (decision 41). Before each model request, if the last reply's reported `inputTokens` plus a rough estimate for entries added since exceeds `contextWindow - reserve`, compact first. Estimate with `ceil(characters / 4)` and say so; it is a smoke alarm, not billing. Defaults chosen here: reserve `max(16384, 10% of the window)`, keep the most recent `20000` tokens verbatim (Nova's numbers, `context-size.md`), both overridable per recipe. `contextWindow` comes from an optional `contextWindow` on the model slot and a recipe override. **With no known window, compaction never fires on its own**, and the manual `compact` command still works.

**The cut** is chosen by a pure function `chooseCut(entries, keepTokens)`. It never separates an assistant message that has tool calls from the results of those calls, never cuts inside the most recent steps, and returns "nothing to cut" for an empty or too-short history. Property test, which is the rule that matters: for any generated history and any `keepTokens`, the cut is never between a call and its result, `firstKept` is an entry id that exists, and the kept suffix is non-empty when the history has more than one step.

**The summarizer** goes through the Model slot like any call, with the same model by default and a recipe setting to change it. Its usage is recorded in the compaction entry **and counts toward the run's usage and limits**. Instructions: a generic default you write (progress so far, decisions made, open items, exact identifiers copied verbatim; if a previous summary exists, update it, do not restart), which a recipe can replace. Oversized older tool results fed to the summarizer are cut to a per-entry cap (8,000 tokens estimated) so the summary call itself fits. Say in `notes.md` that this loses detail and why it was chosen.
- The summary call is retried under step 2's policy. If it still fails, or returns an empty or whitespace-only summary, the run parks as `model_unavailable`, with detail `compaction_failed`, and a person's `resume` tries again. Never continue with an unsummarized overflow.
- **The first message alone too large** (decision 6's known limit): no compaction can help, so the run ends `failed` with code `bad_request` and detail `input_too_large`, and says how large it was and what the window is.

**Tool "current state"** (decision 40). An optional `Tool.currentState(state)` returns exact text to show after a compaction. For the timeline it is the page so far. It reads step 3's rebuilt state and is never stored. The testkit's `timeline-test` recipe implements one by returning `renderPage(state)`.

**Capping bulky results on arrival** (decision 40). The model-facing content of a tool result is capped when it arrives (default 50 KiB, configurable per tool and recipe) with a note on how to get the rest (the tool's own hint, for example "truncated; call `get_diff` for the rest"). The record stores what the model saw, with `truncated: { droppedBytes }`; the tool's `details` are separate and only subject to step 2's entry cap. This never rewrites history, so the prompt cache for the stable prefix is kept. A tool whose state depends on the part that was cut must put what it needs in `details`.

**Kill during compaction.** The `compaction` entry is saved only after the summary succeeds, so a kill before the save leaves no trace and the next request simply compacts again, and a kill after the save leaves a complete compaction. Step 2's `crashingStorage` already reaches both. Extend its resume property to scripts that compact.

**Manual compaction** via the protocol's `compact { session, instructions? }`: replace step 6's `unsupported`. It compacts now, with optional instructions for this one summary, and is `busy` while a run is mid-step (decide whether it queues for the next gap; the simplest is `busy`, so choose that and write it down).

## Slices

**Slice 1: the cut.** `chooseCut` and the token estimate, with the property test and fuzz target. Rows (prefix `CMP`, in `context-size.md`): CMP01 a normal cut keeps recent steps; CMP02 never splits a call from its results (property); CMP03 empty and one-step histories give no cut; CMP04 a history of only huge results still cuts at a boundary; CMP05 `firstKept` always exists.

**Slice 2: the view and the entry.** The view builder, the `compaction` entry, replay's handling of it. Rows: CMP06 the view is instructions, summary, state, suffix, in that order; CMP07 replay of the full record still rebuilds tool state exactly after a compaction (the test the done-when names); CMP08 a second compaction updates the first; CMP09 an unknown future field is ignored.

**Slice 3: the trigger and the summarizer.** The loop integration, default instructions, the failure paths. Rows: CMP10 fires at the threshold and not below it (use a scripted model that reports input tokens); CMP11 no known window means no automatic compaction; CMP12 a summary call that fails parks as `model_unavailable` with `compaction_failed`; CMP13 an empty summary does the same; CMP14 the summary's usage counts toward limits; CMP15 the first message alone too large fails with `input_too_large`; CMP16 oversized older results are cut for the summarizer.

**Slice 4: current state and result caps.** `currentState`, the on-arrival cap. Rows: CMP17 the state text appears after a compaction and is exact; CMP18 a result over the cap is truncated with the note and `droppedBytes`, and the record holds what the model saw; CMP19 a tool whose state needs the cut part is caught by a test (put the needed data in `details`).

**Slice 5: the kill matrix and the long run.** Extend step 2's resume property to compacting scripts: kill before and after every append, including around the compaction entry. A long scripted run (many turns, big results, a small window) compacts several times and ends `done` with the `timeline-test` page equal to an uninterrupted, uncompacted run's. Add a scenario for it, which also runs over HTTP (step 6's second level).

**Slice 6: the command and wrap-up.** `compact` over the protocol (a row in `protocol.md`, `CMD14`), `compaction` event (record-derived, so it carries `seq`), update `context-size.md` ("Not discussed yet" answered), `protocol.md`, `overview.md`, README status, `AGENTS.md`, `CHANGELOG.md`, `decisions.md` (the defaults, the estimate, `busy` while mid-step, 104 onward).

## Cases to work through from the catalog

"Compaction: the cut never falls between a tool call and its result. An empty history. A summary call that fails, or returns nothing. A second compaction over the first. Replay still works from the full record." And "killed at every point ... during compaction." Also "an entry over the cap": a compaction summary is itself an entry, so it is truncated like any other, and a test must show a run survives that.

## Judgment calls already made

Reserve `max(16384, 10%)`. Keep 20,000 tokens. Four characters per token. Summary failure parks, never continues. Manual compaction is `busy` mid-step. Summarizer input has a per-entry cap of 8,000 tokens. No known window means no automatic compaction.

## Mechanics changed in this step

`ModelSlot` gains an optional `contextWindow`. `Tool` gains optional `currentState`. A new record entry kind. No new entry point or dependency. `docs/context-size.md` gains its first row table.
