---
title: "Step 2: limits, retries, and resume"
status: planning
category: features
---

# Step 2: limits, retries, resume

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-02-limits-retries-resume`, cut from a `main` that has step 1 merged. Builds decisions 10, 15, 18 to 27, 58, 90, 91, and the matching parts of 62 to 64. It makes the core safe to leave running: bounded, interruptible, and able to pick up where it stopped.

Read: `docs/limits-and-interruptions.md` (the owner of this step's behavior), `docs/run-record.md` (its rows `REC01` to `REC09` are this step's, and are currently listed in `scripts/unbuilt-rows.json`), `docs/adapters.md` (the Waking slot), `docs/engineering-practices.md` (catalog: "The loop", "The record and resume"), `docs/implementation/notes.md` (what step 1 decided), and step 1's code, in particular `core/run.ts`, the record, and the testkit.

## Goal and done when

From `first-slice.md`: **a fault-injection test kills a run partway and checks that resume continues and that a tool not safe to repeat is never run twice. An oversized input never makes a save fail (decision 90), and a resume against a changed tool set parks the run (decision 91).**

- a run can be bounded by steps, tokens, time and cost, and parks (not fails) when it hits one;
- a run can be stopped, steered, and given a follow-up;
- a failing model call is retried three times with growing delays, then a recipe's fallback model, then the run parks as `model_unavailable`;
- the stuck safeguard parks a run that cannot make progress;
- a run killed at **every** storage write, before or after it, resumes and ends with the same record as an uninterrupted run, and an unsafe tool is never run twice;
- every record entry is capped (1 MiB default) by truncation with a marker, so a save never fails for size;
- a resume checks the tool set against the header's pin, and parks with `recipe_changed` when it differs;
- `REC01` to `REC09` are tested and removed from `unbuilt-rows.json`.

## Out of scope

Approvals and `waiting_for_person` (later slice), proposals, compaction and its kill point (step 7), the protocol and sessions (step 6, which is where "a follow-up on an idle run starts the next run", decision 100, is built, so do not build that here), recipes beyond the minimum below (step 3), Cloudflare (step 4).

## Settled here

**A run object and a runtime.** Step 1's `runTask` stays the primitive. Wrap it in `createRuntime(deps)`, which owns a registry of the runs active *in this process* and returns `start`, `resume`, `wake`, and a handle per run with `abort()`, `steer(text)`, `followUp(text)`, `subscribe(listener)`, and an `outcome` promise. The registry is what makes a late or duplicate wake harmless.

**`RunDefinition`,** the minimal recipe this step needs: `{ name, version, instructions, tools, limits?, fallbackModel?, stuck?, retry? }`. Step 3 grows it into the full recipe. The header stores its pin: `recipe: { name, version, toolSetHash, instructionsHash }`. (`run-record.md`'s header list has no instructions hash, and REC06 needs one to tell "reworded instructions" from "same". Add it to the doc, and say so in `notes.md`.)

**Tool-set hash.** SHA-256, hex, of the canonical JSON (keys sorted at every level) of the list of `{ name, parameters }` sorted by tool name, computed with `crypto.subtle.digest` (web-standard, so it is async). It covers names and argument schemas, **not** descriptions or the instructions' wording (decision 91).

**Limits** (decisions 18, 22). `limits: { steps?, tokens?, timeMs?, cost? }`, all optional, none by default. Rules that the docs left open, now decided:
- A limit must be a positive integer (`cost` a positive number). Zero, negative or non-finite is `bad_request` when the run is created, so a bad config fails fast rather than parking a run before it starts.
- Limits are checked **before each model request**. `steps` counts model turns, so `steps: 3` allows three turns, and a run that finishes on its third turn is `done`, not parked. `tokens` is input plus output summed over replies. All three are derived from the record, so they are cumulative across resumes.
- `timeMs` measures active time since the latest `running` or `resumed` status, not calendar time, because a parked run costs nothing. A person's `resume` can pass new limits.
- Hitting one saves `status: parked`, reason `limit`, detail `steps | tokens | time | cost`, and ends with one `run_end` of `parked`.
- A `cost` limit counts reported cost of any source. If the run has a cost limit and a reply reports no cost, save one note entry (`limit_unenforceable`) and carry on, rather than silently pretending the limit works (decision 15). Readers skip a note kind they do not know.
- The usage summed over steps equals the total reported, even when a later call fails.

**Stop, steer, follow-up** (decisions 19, 27).
- `abort()` cancels the model request in flight and signals the running tool (step 1's abort path), then parks `stopped`. A second abort is a no-op.
- `steer(text)` is read by the model at the next **gap between steps**: after the current tool batch is saved and before the next model request. It is saved as a `user_message` with label `steer` **at that moment, not on arrival**, because writing it between an assistant message and its tool results would break the call and result pairing. Consequence, to state in the PR's Unfinished section: a steer that was queued but not yet read is lost if the host dies first. A steer that arrives after the run ended is refused with `conflict`.
- `followUp(text)` is read when the run would otherwise end, meaning a `finish` was accepted or the model stopped without one. It is saved as a `user_message` with label `follow_up` and the run continues instead of ending. Several are read in arrival order.
- Both texts are subject to the entry cap (below): over the cap is `bad_request` and nothing is queued.

**Retries and the fallback** (decisions 26, 58). A `ModelError` with `retryable: true` is retried up to three times. Delays default to `[1000, 4000, 16000]` ms, taken as a floor under the error's `retryAfterMs`, slept on the injected clock, and aborted by a stop. A non-retryable error is not retried. After the third retry:
- if the definition names a `fallbackModel`, save a `fallback` entry (`from`, `to`, `reason`), emit `fallback`, and continue on the fallback with the **same** retry policy (decision 58 left this open; the simplest consistent answer is no special case). The run stays on the fallback until it ends;
- otherwise, or if the fallback also fails, park as `model_unavailable` with the last error's code and a truncated message as detail.

The retry count goes in the assistant message (`retries`) and in `retry` events. A **resume always starts on the primary model**, because an evicted run is rare and "which model was I on" would be one more thing to derive.

The model error handling in step 1 changes here (a retryable error was `failed`). Step 1's rows for it are revised in the same commit, with the reason, as the matrix rule allows.

**The stuck safeguard** (decision 25), default on, configurable (`stuck: { enabled, reminders, sameFailure }`):
- The model replied with no tool call and has not finished: remind it up to **2** times (a short, fixed `user_message` labelled `reminder`), then park `stuck` with detail `stopped_without_finishing`.
- A tool fails "the same way" **3** times in a row, where *the same way* means the same tool name and the same error code and the same first 200 characters of the error text. Then park `stuck` with detail `repeated_failure` naming the tool.
- A reply cut off by the token limit counts as a failure of its own kind: it is asked again and counts toward the same-failure total.
- These replace step 1's immediate `stuck` park, and its row changes with the reason.

**The entry cap** (decision 90). `maxEntryBytes`, default 1,048,576, measured in UTF-8 bytes of the encoded line, and never above the storage adapter's own limit (add an optional `maxEntryBytes` to `StorageSlot`; the memory adapter's configurable limit from step 1 uses it). Before saving, the core truncates content fields (a tool result's `content` and `details`, reasoning text, assistant text, tool-call arguments, a proposal's evidence when it exists) until the line fits, cutting at a code point boundary (never splitting a surrogate pair), appending a marker, and adding a `truncated: { field, droppedBytes }` entry field so the marker is data and not just text. **Structure is never truncated:** ids, types, small fields. A user message, steer, follow-up or task input over the cap is `bad_request` and nothing is saved. Tool-call arguments over the cap are the awkward case, since cutting them changes what a resume replays to the model. Truncate them, mark them, and say so in the PR. The invariant to test: **no input of any size makes a save fail or fails the run for size**, including a pathological entry whose structure alone is large (decide what that does, test it, and write it down).

**Resume** (decisions 20, 23, 24, 91). `resume(runId, { by: 'wake' | 'person', limits? })`. Read the record and branch on its last status:
- `done` or `failed`: nothing to do, return the recorded outcome.
- `parked` for `stopped`, `limit`, `stuck`, `model_unavailable` or `recipe_changed`: **only `by: 'person'` continues it.** A wake leaves it parked. This is "a stop waits for a person" (decision 23).
- `running` (the host died): either may continue it.
Continue by saving a `resumed` status, then looking at the tail:
- **An assistant message with calls that have no result.** For each such call: if the tool is `safeToRepeat`, run it now. If not, save an error result `outcome unknown: this call may or may not have run; check before repeating` and do **not** run it. The record cannot tell "killed before it started" from "killed after it did something", so the rule is conservative: an unsafe call with no result is never re-run. The tool gets a stable key, `ctx.callKey = runId + ":" + callId`, so a tool that wants to be made safe (decision 24) can dedupe on it. Then continue the loop.
- A user message or a tool result last: ask the model. (A model request that was in flight is simply asked again, which costs one extra call, `limits-and-interruptions.md`.)
- An assistant message without calls: apply the done and stuck logic again.

**Recipe pin on resume** (decision 91, `REC05` to `REC09`). Compare the current definition to the latest pin (the header's, or the most recent `recipe_updated` entry's):
- same tool-set hash, same version and instructions hash: continue, no extra entry;
- same hash, different version or instructions hash: continue and save a `recipe_updated` entry noting old and new;
- different hash: save `status: parked`, reason `stuck`, detail `recipe_changed`, listing the tools added, removed, and changed by name (a tool the record already used that is now gone is the case this protects against, so flag it). A later `resume` by a person continues with the new tools, saving a `recipe_updated` entry that names the change, and becomes the new pin.

**Waking** (decisions 12, 23). Define it concretely: the runtime schedules a wake `wakeAfterMs` (default 60,000) ahead when a step begins, re-arms it each step, and cancels it when the run is done, failed or parked. If the host dies, the wake fires and the host calls `runtime.wake(runId)`. `wake` is idempotent: a run active in this process's registry is left alone, a run that is `done`, `failed` or person-parked is ignored (and not re-armed), and only a `running` record with no live owner resumes. This is what makes "an alarm that fires late, twice, or while a request is running" harmless.

## The fault-injection harness (testkit)

Add to the testkit, with its own rows (`KIT`):

- **`crashingStorage(inner, { at: n, when: 'before' | 'after' })`** simulates process death at the *n*th append. It does **not** throw, because a throw would let the "dead" run's error handler keep writing and running tools. At the chosen point it returns a promise that never settles: `'before'` without writing the line, `'after'` once the line is persisted. The abandoned run is frozen there and can do nothing more, exactly as a killed process. The test never awaits it. The inner storage is then handed to a fresh runtime and `resume` is called.
- Together, `before` and `after` over every `n` reach every kill point the catalog lists: before the model request (after the previous write), after the model reply but before the tool (after the assistant write), during the tool (before the result write), and after the tool but before its result is saved (before the result write). Compaction's kill point joins in step 7.
- **Resume-safe scripted model.** Step 1's reply-by-position model already returns the same reply to a re-asked request. Check that `failures` counters reset with a new model instance, which is what a restarted host looks like.
- **Execution counters on scripted tools,** so a test can assert how many times a tool really executed, keyed by call id.

## Slices

**Slice 1: the cap.** Truncation, the marker, `maxEntryBytes` on storage, `bad_request` for oversized user text. Rows `REC01` to `REC04` (`run-record.md`) plus: a user message of exactly the cap and one byte over, multibyte text cut mid-character, a pathological structure, and an adapter limit below the cap. Fuzz target: any entry, any size, any content, saves within the limit and loads back.

**Slice 2: limits.** Rows (prefix `LIM`, in `limits-and-interruptions.md`): LIM01 each limit parks with the right detail; LIM02 steps exactly reached versus one below versus finishing on the last allowed turn; LIM03 zero and negative are `bad_request`; LIM04 time uses the fake clock and counts active time across a resume; LIM05 cost limit with no reported cost writes the note; LIM06 a resume with larger limits continues; LIM07 property: usage summed over steps equals the total, even when a later call fails.

**Slice 3: stop, steer, follow-up.** Rows (prefix `STP`): abort before the first request, during the model call, during a tool, between steps, twice; steer during a tool, during the model call, and after the last step (refused); the steer is saved at the gap and the pairing stays intact; follow-up queued during a run and read at the end, several in order; an oversized text is `bad_request`. The record order of a steer relative to a tool batch is the assertion that matters.

**Slice 4: retries and the fallback.** Rows (prefix `RTY`): succeeds on attempt two; exhausts after three; a non-retryable error is not retried; the delay honours `retryAfterMs` as a floor and uses the fake clock; a stop during backoff aborts the sleep; the fallback is used after the retries and recorded (`fallback` entry and event, which is also the protocol's EVT03 behavior); the fallback also failing parks `model_unavailable`; a resume starts on the primary; a model error with a 200 body is the adapter's job (step 5), so only the slot's `retryable` flag is tested here.

**Slice 5: the stuck safeguard.** Rows (prefix `STK`): a stop without finishing is reminded twice and then parked; a tool failing the same way three times parks; a different error in between resets the count; the safeguard turned off never parks; a reply cut off at the token limit counts; a reply that tries to end the run without the done-check passing is not done. Revise step 1's `stuck` row.

**Slice 6: the definition pin and resume.** The harness, the resume algorithm and the wake. Rows `REC05` to `REC09`, then `RSM`:
- RSM01 happy: kill at every `n`, both variants, on a three-tool script: the resumed run ends `done` with a record equal to the uninterrupted run's, ignoring `resumed` status entries and unknown-outcome results.
- RSM02 sad: an unsafe tool killed anywhere is executed **at most once** per call id across the original and the resume, and the model is told the outcome is unknown. A safe tool may run again.
- RSM03 sad: a wake on a person-stopped run leaves it stopped; a `person` resume continues it. A wake on a live run does nothing. A wake delivered twice resumes once.
- RSM04 bad: resume on a record with a damaged tail, an unknown entry kind, an unreadable header (`failed`, code `internal`, never a crash), and a record that does not exist (`not_found`).
- RSM05 property: for any generated script, any `n`, either `when`, the resume ends in exactly one `run_end` per segment and a loadable record, and the final conversation equals the uninterrupted run's. Seeds print on failure.
- RSM06 happy: resume after `model_unavailable`, `limit` and `stuck` parks, by a person, with the new limits.
- Include a run killed while it holds queued steers or follow-ups, and say in `notes.md` what is lost.

**Slice 7: waking in the memory adapter and the wrap-up.** Make the memory `WakingSlot` drive the runtime in a test (schedule, fire, resume). Update `limits-and-interruptions.md` (a row table, and the "Not discussed yet" items now answered), `run-record.md` (the header's instructions hash, new entry kinds `fallback`, `recipe_updated`, notes), `adapters.md`, `overview.md`, the README status, `AGENTS.md`, `CHANGELOG.md`, `decisions.md` (the calls above, 104 onward), and **remove `REC01` to `REC09` from `scripts/unbuilt-rows.json`**, deleting the `docs/run-record.md` entry if it is empty.

## Cases to work through from the catalog

"The loop": limits (a step limit exactly reached, one below, zero, negative; a token, time or cost limit mid-run), stop and steer at each point, retries, the stuck safeguard. "The record and resume": killed at every point, a tool not safe to repeat, an entry over the cap (each content kind, exactly the cap, one byte over), resume after a deploy (same tool set, reworded prompt only, tool added, tool removed that the record used, arguments changed, resume after `recipe_changed`). "Cloudflare" items about alarms belong to step 4. Give each bullet a row or note why not.

## Judgment calls already made

Retry delays `[1000, 4000, 16000]` ms. Reminders 2, same-failure 3. Wake interval 60 s. Resume always starts on the primary model. Time limit counts active time. Steers are saved when read. An unsafe call with no result is never re-run, even if it provably never started. The tool-set hash excludes descriptions. All provisional, to be tuned after real runs; say so in `notes.md`.

## Mechanics changed in this step

`StorageSlot` gains an optional `maxEntryBytes`. The testkit gains `crashingStorage` and counters. `scripts/unbuilt-rows.json` shrinks. No new entry points and no new dependencies. Watch the size budget: this step adds real code to the core.
