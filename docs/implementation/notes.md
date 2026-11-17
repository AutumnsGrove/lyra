---
title: "Lyra implementation notes"
status: planning
category: features
---

# Implementation notes

The handoff file (see [`README.md`](README.md)). Judgment calls, surprises, and loose ends from building, newest first. One short entry each, headed with the step and the date, saying what was chosen and why. Autumn reads this before she reads a diff.

Nothing has been built yet.

## Step 1b, 2026-11-17

- **Uniqueness is per reply, not per run, and that is deliberate.** The review's last observation was that
  a later turn may supply an id the loop generated earlier (`c1` in turn 0, the model's own `c1` in turn
  1). Nothing breaks: the record's entry ids are a separate prefix, replay is positional, and pairing is
  checked against the immediately preceding assistant message, which is what a provider checks. Making ids
  unique per run would need a set that grows with the run for no case that fails, so it stays per reply
  and LOOP09 says so.

- **Two rounds of the same bug: ids have to be decided once, and against the whole batch.** The first fix
  normalised an unusable call id where the reply enters the loop, but a *generated* id was only checked
  against the calls already visited, so with the counter handing out `c1` a reply of `["c1", ""]`
  normalised to `["c1", "c1"]`. `normalizeCalls` now reserves every id the reply already uses before it
  generates any, and the counter is advanced past them. LOOP09 has the deterministic case; relying on the
  property test alone would have missed it, because the generator's ids lived in a namespace the counter
  never produces, which is the same blind spot that hid the original bug.
- **`normalizeCalls` is the single place an id is decided**, and `executeTools` now assumes unique non-empty
  ids rather than inventing them. A future caller of `executeTools` outside the loop would break that
  assumption, and the function says so where it is documented.

- **The review found the empty-id gap that the notes had claimed was handled.** Ids were normalised in
  `executeTools`, which runs *after* the assistant message is saved and after the conversation is pushed,
  so a call with no id was written as `""` in the turn, the conversation and the next request, while its
  result was saved under a generated id: a provider rejects that pairing, and a resume replays it. The
  cut-off path was worse, because it skips `executeTools` entirely and wrote a `tool_message` with an
  empty id, which the record refuses — so the turn and its results silently left replay. Fixed at the one
  place that can be right: `normalizeCalls` runs where the reply enters the loop, before anything is
  written, so the turn, the results, the conversation and the record all carry the same ids. `executeTools`
  no longer invents or de-duplicates anything, and LOOP09 states the rule.
- **The generator now makes the bad ids too.** It only ever produced `c0_0`-style ids, which is why LOOP12
  could not have found this; it now generates no id, a repeated id and its own id, and with the fix removed
  LOOP12 fails on `{"id":"","name":"alpha"}`. The same gap applied to repeated ids, so they are normalised
  the same way and both calls run rather than the second being refused.
- **A run that saved everything it wrote leaves a record with nothing to note.** LOOP12 asserts that now,
  which is what turns "the record loads" into "the record is right".

- **What 1b does not have, on purpose.** No limits, no retries, no resume, no steering: those are step 2,
  and the run's seams are where they go (one `runTask`, an injected clock, a record already written
  before each step). No protocol: `src/protocol/` is step 6, and the events already use its names so it is
  a mapping, not a redesign.

- **The conformance survey, and what it changed.** Pi's `packages/agent/test/agent-loop.test.ts` (2,357
  lines) and Nova's `agent/*_test.go` were read for cases the rows missed. Most of Pi's are about things
  Lyra does not have on purpose (parallel tool batches, hooks, steering queues, custom message types); the
  cases that applied became LOOP14 (what every event carries), LOOP15 (nothing left waiting after any
  ending, and a run with no listener) and LOOP16 (a tool that never settles). The rest were already
  covered: a cut-off reply (LOOP04), every call of an aborted batch answered (LOOP06), exactly one
  `run_start` and `run_end` with nothing after (LOOP01, LOOP11).
- **`seq` is the line's position in the record, so line 0 is the header.** A record-backed event whose
  `seq` is 1 points at `entries[0]`. Writing LOOP14 caught that mistaking it for an index into `entries`
  is easy, and step 6's catch-up code has to get it right.
- **A `tool_call` event carries no `seq`.** It comes from no record entry of its own: the assistant
  message it belongs to is already announced by `message_end`, and the call has an id. Two events sharing
  one `seq` would have broken the "only increases" rule the protocol leans on (decision 86).
- **Not built, and worth saying: a tool result has no duration.** Nova records how long a tool ran and Pi
  does too; `run-record.md` does not ask for it and no row needs it, so the entry stays as it is. The
  record allows another field, so it can be added when a viewer wants it.

- **`scenarios/abort.yaml` found a lost stop.** A stop that arrives after a call is announced (`tool_start`)
  and before the tool's own listener is attached never fired, because a listener added afterwards does not
  see an abort that already happened; the tool then slept out its full time and reported success while the
  run parked. `runOne` now checks the signal after attaching, and the scenario is the regression test.
- **Scenario fields use the protocol's spelling; events stay camelCase.** The files say `call_id` and
  `is_error`, because step 6 runs the same files over the wire and a rename would touch every file. A small
  translation table in the runner maps them onto the in-process events, and `expect_record` accepts either
  spelling.
- **The testkit may read the record.** The scenario runner loads what a run saved to check its
  `expect_record`, so the testkit's allowed imports gained `src/record`: it is part of the core entry point,
  and the rule is about reaching into adapters, not about the record.
- **`import.meta.glob` is declared in `packages/lyra/testing/glob.d.ts`, not in `src/`.** The declaration is
  included by `tsconfig.json` for the typecheck and left out of `tsconfig.build.json`, so the test can see
  Vite's global while the published types never claim a runtime has it.

- **The property test earned its keep on its first run.** LOOP12 found two gaps the rows had missed: an
  assistant turn the model saved badly (a nameless call, no call id, one id twice) was *written* by the
  loop and then *refused* by the record's loader, so the turn disappeared from history and its results
  were left orphaned; and a run whose header could not be saved still wrote its closing status into a
  record that had never started. Both are fixed, RCD08 covers the first, and the second is in the same
  commit because it is the same rule: the record keeps what the run wrote, or nothing.
- **Two decoders for tool calls, on purpose.** `decodeReply` is strict, because it guards an adapter and
  an empty id or name is a bug there. The record's reader is tolerant, because it preserves what
  happened, including a call the loop then refused to run. One is a boundary, the other is history.

- **The duplicate-call-id rule is "the first one runs".** A reply with one id twice cannot be paired
  twice, and refusing both would throw away the call the model got right. The second is answered with an
  error that says so, so the record has one result per call and the model learns what went wrong.
- **A tool call after an accepted `finish` is answered, not run, and the loop stops there.** The
  remaining calls are answered in the order they arrived, so the record stays paired, and the run ends
  `done` without ever asking the model again.

- **A stop is detected by the signal, not by what the slot returned.** From inside the request, an
  abort and a provider failure look identical: the fake model rejects with "sleep aborted" and a real
  `fetch` rejects with an `AbortError`. So the signal is checked before the error is believed, which is
  also why a run stopped during a model call parks instead of failing (LOOP06).
- **A closing status that cannot be written turns `done` into `failed`.** The step document says a
  failed save anywhere ends the run `failed`, and the closing status is a save like any other; reporting
  `done` with a record that says `running` would leave a resume reading a finished run as interrupted.
  The record keeps what was written, so the failure is visible rather than papered over.

- **The cost total is dropped, not approximated.** LOOP03 caught the first attempt: the accumulator
  began at zero tokens with no cost, so the first reply's cost was thrown away and the total came out
  at nothing. The rule now is that a total is reported only when every reply reported one from the same
  source, and one reply without a cost makes the answer "unknown" rather than too low (decision 15).
- **A tool call with no id gets one from `Ids`.** The model can send a call with an empty id, the record
  needs a non-empty `toolCallId`, and dropping the call would leave a call the model made with no
  answer. It is saved under a generated id and its content says it was not run, so the record stays
  paired (LOOP09).
- **The tool deadline is a sleep on the injected clock, cancelled by aborting the call's controller.**
  That keeps `clock.pending()` honest, so LOOP02 can assert that a run leaves no timer waiting, which is
  this project's version of Nova's "no goroutine leak" (LPC06).

- **1a merged as `0e02714`**, and the step is marked `merged` in the status table. The wait was my
  reading of the guide's "never merge" as absolute while Autumn was waiting on a sign from me; decision
  107 records the reversal, the conditions that still apply, and why.

- **A review caught a test that could not fail.** The header refusals were passed as line 2 of a record,
  where the loader calls them "a second header" before any header decoding happens, so the assertions
  passed whatever the decoder did. They moved to RCD05 as first lines, `startedAt: -1` was added, and the
  case now bites: breaking the `run` check in `decodeHeader` fails RCD05. It is the guide's own lesson
  (`assert the positive case first`) in a different disguise: the test proved the loader skipped a line,
  not that the decoder refused a header.

- **What 1a deliberately does not have.** There is no loop, no scenario runner, no conformance port and no
  `scenarios/` directory, because those are 1b (slices 6 to 8) and 1a is meant to be reviewable on its
  own. What it does have is everything those stand on: the slot types, `decodeReply`, the record, the
  memory adapter, the testkit, and the gate rules that keep them honest.

- **The fake clock resolves nothing without an `advance`, except a zero delay.** `sleep(0)` resolves on
  the next microtask instead of waiting to be advanced, because a script that says `delayMs: 0` should
  not need a clock tick nobody wrote. Everything longer waits for `advance`, which is what makes the
  deadline rows in step 1b (a tool that outsays its deadline) a matter of moving the clock rather than
  waiting 5 minutes.
- **The scripted model lets an abort reject, rather than answering with an error result.** A real
  adapter's `fetch` rejects when the signal fires, so the fake does the same, and the loop is written
  to survive a slot that throws on abort (LOOP06). If it answered `{ ok: false }` instead, the abort
  path would look calmer than reality.
- **`failingStorage` never calls the wrapped adapter on the failing append.** That is what makes "a
  save fails" mean what decision 20 says: nothing is written, so there is no half-record to reason
  about.
- **Two testkit exports were cut before they landed**: a read-only storage and an "empty read" helper,
  both unused, both out of step 1a's scope. The rule is the project's own: do not add a module or an
  entry point before its first test needs it.

- **The storage contract is a `.testing.ts` file that registers cases**, so `matrixcheck` now reads
  test titles from those files too. Without that, the STO rows would look untested while the cases ran
  in every adapter. The alternative was naming the file `*.test.ts`, which Vitest would then run as a
  file with no tests.
- **`importcheck` grew three small rules with the first adapter.** An adapter lists the directories it
  may import (`allows`, with its own directory always permitted); a test file may reach across entry
  points, because nothing in it ships; and production code may not import a `.testing.ts` file. That
  last one is checked for both suffixes, because a relative import is written with `.js` and my first
  attempt only looked for `.testing.ts`, so the violation passed.
- **The in-memory storage limit defaults to 1 MiB**, the record's own entry cap (decision 90), rather
  than to some larger number. A test cannot then accidentally prove that a line saves when the real
  record could not hold it.

- **The header is not an entry, so the first entry's `parent` is `null`.** Decision 31 says the header's
  parent is null; making the first entry point at the header instead would have added an id the header
  does not need. `activePath` therefore stops at `parent: null`.
- **Replay walks from the last entry, and a sibling is not on that path.** A test that gave two tool
  results the same parent caught it: the second result was on a branch and so was not in the
  conversation. That is the tree shape doing its job (decision 30), and the lesson is that the loop must
  link each saved entry to the previous one, not to the message it answers.
- **An unknown entry kind keeps its raw line.** The alternative was a re-encoded copy, which would have
  quietly rewritten a newer writer's entry into an older shape. `encodeEntry` returns `raw` untouched,
  so loading and saving a record is lossless even across versions.
- **`details` goes through a depth-capped JSON check.** It is the only field a tool can put any shape
  into, it is written to the record, and a 70-level document would otherwise recurse until the stack
  gave out. Over 64 levels the line is refused with a note, like any other damaged line.

- **`null` is a wrong type, not a missing field.** `decodeReply` reads an absent token count as zero,
  and a `null` one as a `bad_request`. The tidier-looking `value.x ?? 0` quietly made them the same
  thing and MOD05 caught it. The rule that fell out: only `undefined` is missing; anything else
  present has to be the right type, because a provider that sends `null` is telling us something we
  do not model, and a count that became zero would hide it.
- **fast-check 4.10.2, pinned, at the workspace root.** The property and fuzz targets import it from
  `packages/lyra/src`, which resolves through the root `node_modules`; `importcheck` accepts it because
  the root's `devDependencies` count as test-only tooling and no production file may import it
  (decision 105).

## Step 1a, 2026-11-17

- **Step 0 is waived for 1a**, on Autumn's answer to the question in this session. Recorded as decision 104, because the reversal is hers and the record should say so.
- **The web platform is declared, not imported.** `tsconfig.json` builds with `lib: ["ES2023"]` and `types: []`, so `AbortSignal`, `crypto`, `setTimeout` and `TextEncoder` do not exist at all. Rather than add `DOM` to `lib` (which would also let `document` and `window` typecheck in code that has to run on Workers), `src/platform.d.ts` declares exactly the surface the core may use, with only the members it calls. Adding to that file is now a deliberate act, and a missing name fails the typecheck. Step 5 will need an answer for `fetch` in the adapters: either the same file grows, or `lib` gains `DOM` for the whole package.
- **The banned-globals rule counts comments.** `importcheck` scans the raw source, so a comment that mentions `setTimeout` fails the build. That is stricter than it needs to be, and it is on purpose: the message is what teaches the rule, and a file discussing a timer is usually a file about to set one. A declaration file is skipped, because declaring a global emits no code.
- **CLK02 costs one real millisecond.** The row tests `core/system-clock.ts`, which is the wrapper around the host's own time, so it cannot be tested without a timer. The waits are 1 ms (resolve) and 60 s that is aborted before it elapses, so nothing in the suite actually sleeps. Every other test uses the fake clock from step 1a slice 5.
- **`system ids` use 128 bits as hex**, `prefix_` plus 32 hex characters, from `crypto.getRandomValues`. Decision 85 asks for 128 bits on an unguessable id, and the same source will serve approval ids in step 6, so there is one answer rather than two.
