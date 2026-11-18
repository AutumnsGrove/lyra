---
title: "Lyra implementation notes"
status: planning
category: features
---

# Implementation notes

The handoff file (see [`README.md`](README.md)). Judgment calls, surprises, and loose ends from building, newest first. One short entry each, headed with the step and the date, saying what was chosen and why. Autumn reads this before she reads a diff.

## Step 2 merged, 2026-11-18

Step 2 is merged as pull request #6 (`d278c82`) and `main` is green. It took two review rounds: the first
found a stale finish flag that silently dropped a follow-up's work and a truncated field whose bytes were
not counted, both fixed test-first; the second found nothing. **Step 3, recipes and tools, is next**, and
it starts from this `main` — the size ceiling is 52 KiB (decision 109), and the only unbuilt rows left are
the 28 protocol ones that step 6 builds.

## Step 2, review round one, 2026-11-18

- **The review found a stale finish flag, and it was right.** After a follow-up continued a run,
  `finishedRun` still said the job was done, so every call of the turn the follow-up caused was answered
  "the run already finished" and the run ended on the old flag: the follow-up's work was dropped. STP04
  passed anyway, because the refused finish turned into an error result and the stale flag supplied
  `done` — a test that proved the loop did not crash rather than that it did the work. It now clears the
  flag before continuing, and STP04's test asserts the follow-up turn's `finish` really ran.
- **The review also found a field wiped without being counted.** When one field could not fit even
  emptied, truncation left it empty and moved on, and a smaller field that did fit then supplied the
  `droppedBytes`: 1.2 KB of tool arguments disappeared from an entry whose marker named only the other
  field. The wiped field's bytes now join the total, so the marker accounts for everything the entry
  lost, and a new REC04 case fails if they stop doing so.

- **A done-check that is not the last act is not the end of the run.** `finished` in the resume seed
  looked at the last *tool result*, so a record that had an accepted finish and then a follow-up ended
  `done` on resume and silently dropped the follow-up. It now looks at the last *message*: a tool result
  with `done` at the very end means finished, anything after it means the run has more to do. The case is
  RSM01's "a follow-up saved after an accepted finish is not skipped".
- **Time spent before a crash is not counted.** A run killed mid-call has a `running` status and no
  closing one, so the segment never closes and its active time is not in the record. It cannot be
  measured after the fact without using calendar time, which would count the downtime as work. The time
  limit therefore under-counts by whatever the last, interrupted segment did, and it is the conservative
  direction for a limit.

## Step 2, slice 7, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** Step 2 is complete on
`feat/step-02-limits-retries-resume` and its pull request is open.

- **The runtime arms the wake, and the host fires it.** `turn_start` sets one wake a step ahead,
  `run_end` cancels it, so a run that is working always has exactly one alarm and a run that has stopped
  has none. Which run is woken is the host's business: `wake` is what an alarm calls, and it is the
  registry that makes a late or doubled alarm harmless.
- **A broken Waking slot cannot fail a run.** The scheduling is a fire-and-forget promise on the
  handle's event stream, and the stream isolates a throwing listener, so a host whose alarm cannot be
  set loses the automatic resume and nothing else. That is the right trade for a slot that is a
  convenience, and it is the reason WAK01 asserts on the slot's own record rather than on the run.
- **The memory adapter's `memoryWaking()` returns a wrapper, not a slot.** A test passes `waking.slot`
  to the runtime and inspects `waking.scheduled()`/`fire()`. Passing the wrapper silently did nothing,
  because the runtime caught the missing method as a listener error; the row that caught it is WAK01.
- **`LIM06` and the resume half of `LIM04` are in the limit rows, not the resume rows**, because what
  they test is the allowance arithmetic across a resume: turns already spent still count, and active
  time already spent can park a run before it asks anything.

## Step 2, slice 6 (part three), 2026-11-17

- **A resume has to move the host's id source past the record's ids, and the test fake is what found
  it.** `counterIds` starts again at one in a restarted process, so a resume wrote `e2` into a record
  that already had one; the loader skipped both the `resumed` status and a tool result as duplicate
  ids, and the run still reported `done`. `reserveIds` now advances the source until its next id is
  clear. A random source spends one draw, which is why it is a loop and not a check. A production
  `systemIds` would have hidden this for a long time.
- **`until` and `drive` now turn the event loop, not just the microtask queue.** The recipe pin hashes
  with `crypto.subtle`, which finishes off-thread, so a run that pins was invisible to a
  microtask-only poll: the test spun 500 times and then asserted on a record that had not been written
  yet. Vitest's own timer is the only real timer available to a file under `src/`, where `setTimeout`
  is banned so no test can sleep on the clock it is testing.
- **A resume that ends on the record's own word writes nothing at all.** `recordedOutcome` used to
  return the ending and then the closing-status block appended a second `parked` status; the wake row
  caught it as a line count that grew when it should not have.
- **The runtime's registry is what makes a wake idempotent.** A run in `runs` is joined by a later
  wake or resume, and a resume still reading the record is in `inFlight`, so two alarms share one
  promise. That is the whole of "late, twice, or while a request is running is harmless".
- **Who may resume what is decided by the record's last status, not by the reason.** A wake continues
  only `running`; a park of any kind waits for a person. `recipe_changed` therefore costs a person one
  explicit look, which is what decision 91 asks for.

## Step 2, slice 6 (part two), 2026-11-17

- **The header's pin grew two fields, and `run-record.md` says so.** `REC06` cannot tell a reworded
  prompt from the same one without an instructions hash, and `REC07`/`REC08` cannot name the tool that
  moved from a single set hash, so the header keeps `instructionsHash` and one `{name, hash}` per tool.
  Both are optional, so a record written without them still loads, and the pin's rows cover that.
- **Descriptions are out of the hash on purpose.** Rewording a tool's description does not change what it
  does, so a resume must not stop for it; `REC05` tests exactly that (two descriptions, one pin).
- **A person resuming a `recipe_changed` park does not accept the new tools by accident.** The first
  person resume of any other park is checked against the pin and parks if the tools moved; only a resume
  whose record already says `recipe_changed` continues, writes `recipe_updated`, and becomes the new pin.
  That is the strict reading of "a later resume continues", and it means a changed tool set always
  costs a person one explicit look rather than being accepted by a resume they started for another reason.
- **`recipe_updated` may have no `from`.** A record started before pins existed has none to compare, so
  the first resume on a recipe writes the pin with `from` absent rather than inventing one.
- **Both new behaviors were mutation-checked.** With `recipeChangeParked` forced to `undefined`, REC07,
  REC08 and REC09 fail; with `noteRecipeChange` unable to write, REC06 fails twice and REC09 fails once.

## Step 2, slice 6 (part one), 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** Step 2 is on
`feat/step-02-limits-retries-resume`; slice 6 is half done: resume of a running record and the crash
harness are in, and the recipe pin, the runtime and the wake are next.

- **The record has to keep the done-check's answer, so a tool result gained `done: true`.** A kill
  between an accepted `finish` and the closing `done` status leaves a record whose last entry is a
  successful tool result, and nothing in the format said whether that result finished the job. Without it
  a resume would ask the model for a turn it already gave, which is the one thing RSM01 rules out. The
  entry is optional, so an older record still loads.
- **A resume writes the task message when only the header landed.** A kill before the second append leaves
  a header with no message; the resume has the job in its own config, so it writes it and continues. The
  record then matches an uninterrupted run's from the first message. `run.ts` has to mark the record as
  started before that write, which is exactly the bug this caught.
- **`readResumeSeed` looks at the whole tail, not the last entry.** A batch saves each result as it
  arrives, so a kill can leave a result for the second call and none for the first; the unanswered set is
  computed against the last assistant turn and every result after it.
- **The `RSM01` comparison is the conversation and results, not the status lines.** Where the kill lands
  decides which status entries exist (a run killed before `running` has none), so comparing statuses
  would test the kill point rather than the resume. The projection drops statuses and unknown-outcome
  results, which is what the step document allows; the row says so.
- **Kill points that are not "cut off mid-call" are tested too.** For a kill before the assistant turn is
  saved there is nothing unanswered, and the resume simply makes the call for the first time; the
  at-most-once rule is about calls the record knows about, so RSM02 separates the two cases.
- **The size ceiling was raised to 52 KiB (decision 109).** The gate failed at 41.6 KiB with the step's
  own work in it, splitting modules does not help because `budget` sums `dist/`, and the growth is not
  padding. This is the one deliberate raise, and the commit says so.

## Step 2, slice 5, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** In short: step 1 is
merged, step 2 is on `feat/step-02-limits-retries-resume` with slices 1 to 5 done, no pull request yet.

- **A failure is identified by the tool's name and the first 200 characters of its text, because a tool
  result carries no code.** The step document says "the same tool name and the same error code and the
  same first 200 characters". `ToolOutcome` has no code yet and no row needs one, so the key is the name
  and the text. When a tool grows a code, the key takes it.
- **A refused tool call counts as a failure too.** Bad arguments never reach the tool, but the model gets
  the refusal as the result and will send it again; that is exactly the loop the safeguard exists to
  stop. LOOP09's script had four identical refusals in a row and now parks, so its cases are interleaved
  and the reason is written in the test.
- **With the safeguard off, a model that cannot finish ends `failed` and says why.** The row says it never
  parks, and it can neither keep going nor report a done-check that never passed, so `failed` with a
  plain message is the honest ending. Recorded here because the step document left it open.
- **A repeated tool failure parks after the batch is answered, not in the middle of it.** The current
  batch still finishes, so the record stays paired and the model sees every result, and only then does
  the run park. A stricter cut-in is a later choice, not a correctness fix.
- **The reminder label was written but not readable.** `MessageLabel` allowed `reminder` since slice 1 and
  the record's reader did not, so the first reminder a run wrote would have made its own record skip a
  line. STK01 loads that record, and the label is in the generator now.
- **Three step-1 rows were revised for the safeguard**, in the same commits as the behavior: LOOP08 (a
  silent reply is reminded, not parked), LOOP09 (its refusals are interleaved so the safeguard does not
  fire), LOOP15 (its parked case needs a run that really parks). Each keeps its original intent.

## Step 2, slice 4, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** In short: step 1 is
merged, step 2 is on `feat/step-02-limits-retries-resume` with slices 1 to 4 done, no pull request yet.

- **A step is a turn, however many attempts it takes.** `turns` counts a model turn once, and the retries
  live on the assistant entry (`retries`) and in `retry` events, so a step limit counts what a person
  thinks of as steps. The retry loop sits inside one `ask`, not inside the step loop.
- **Only a retryable error can reach the fallback.** A non-retryable one is a bug (a bad request, a bad
  key) rather than an outage, so it still ends the run `failed` as step 1 did, and RTY03 keeps that
  separate from the outage path. The fallback follows the retries, gets the same retry policy, and the
  run stays on it, which is what decision 58 left open.
- **A recipe that names no model gets `from: "default"`** in the fallback entry, because the record's
  fields are names and there is no provider name to put there. A later step that always has a model name
  can drop the placeholder.
- **Three step-1 scripts had to change, and the changes say something.** LOOP07's model error became
  non-retryable, because its row is about a failure that ends the run, not an outage. LOOP15's "broken"
  run was the same. LOOP12's generator now makes only non-retryable failures: a random retryable one would
  need 16 s of fake time for a third attempt, and its property harness only drives 10 s. The RTY rows own
  the retry timing, on a clock they move by hand.
- **LOOP15 timing out was the good kind of failure.** A scripted failure defaults to retryable, so a test
  that awaited a failing run with no listener slept out three backoffs on the fake clock forever. It is
  now explicit about being non-retryable, which is what that row was always testing.
- **`retries` is optional in the record** rather than always present and zero, so an old record and a
  record from a run that never retried encode the same way.

## Step 2, slice 3, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** In short: step 1 is
merged, step 2 is on `feat/step-02-limits-retries-resume` with slices 1 to 3 done, no pull request yet.

- **`createRun` is the handle, and `createRuntime` is not built yet.** The step document describes a
  runtime that owns a registry of active runs, with `start`, `resume` and `wake`. Three of those four are
  about resuming, so the registry arrives with slice 6, when it has something to do. Slice 3's rows need
  the handle alone, and `start` is `createRun` for now.
- **A queued text is measured as a real entry when it is queued.** The handle reserves the id and
  timestamp, so the cap check is the entry that will be written, not an estimate from the text length.
  The one unknown is the parent id, so the check measures against a 64-character placeholder: the longest
  id this core makes is 39 characters (128 bits as hex, decision 85), so a text that passes cannot
  overflow once the real parent is linked. A steer and a follow-up are both refused with `bad_request`
  before anything is queued.
- **A steer is written at the gap even when the run is about to park on a limit.** The limit check comes
  after the drain, so a steer that arrived before the limit was reached is in the record and a resume
  replays it, rather than being lost with the handle. The steer does not change what the limit measures.
- **A follow-up is read before the stuck park.** A person's follow-up is new input, so a model that fell
  silent and has a follow-up waiting is not stuck. That ordering is what slice 5's reminders must respect:
  follow-ups first, reminders after.
- **A steer queued but never read is lost when the run ends.** It lives in the handle, not the record, and
  a stop or a kill drops it. Writing it on arrival instead would break the call/result pairing, which the
  step document already chose against. This is the loss the step document asks to be stated.
- **What the tests were checked against.** The steer and follow-up paths were mutated out (`readQueued`
  calls removed) and the matching STP02 and STP04 tests failed, so the rows bite rather than passing on
  their own setup.
- **The steer and follow-up paths were checked by mutation.** With `readQueued("steer")` removed, both
  STP02 tests fail; with the follow-up `continue` removed, both STP04 tests fail. The rows bite.
- **Step 1's two deadline tests were moving the clock too coarsely, and this slice's extra gap `await`
  exposed it.** `drive()` advances the fake clock on every microtask turn, so a run whose finish tool
  resolves in a few ticks could see that call's own 1 s deadline expire first, and the run then asked a
  third request the script did not have. LOOP05 and LOOP16 now advance the clock by the first tool's
  deadline once and then await the run without advancing, which tests the same behavior without racing
  the finish call. Not a product change: one more microtask per loop iteration cannot make a real tool
  miss a deadline that it was nowhere near.

## Step 2, slice 2, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** In short: step 1 is
merged, step 2 is on `feat/step-02-limits-retries-resume` with slices 1 and 2 done, no pull request yet.

- **The limit check is before the request, not inside it.** A limit therefore always lands on a step
  boundary, which is what makes "everything done so far is kept" true without cutting a step in half. A
  tool that runs long can carry a run past its time limit and the park happens at the next gap; that is
  the doc's rule ("checked before each model request") and not an accident.
- **A cost limit it cannot measure is switched off, not guessed at.** One reply without a cost makes the
  running total understated, so the run notes `limit_unenforceable` once and stops enforcing cost for the
  rest of the run (LIM05). Mixing cost sources is fine for the limit, unlike the reported total, which
  still needs one source (decision 15): the note's accumulation counts every amount reported.
- **When two limits are reached at once, the order in `LIMIT_DETAILS` decides** (`steps`, `tokens`, `time`,
  `cost`). Fixed rather than incidental, so the same state always writes the same detail.
- **`LIM06` is deliberately skipped and waits for resume.** The planned row was "a resume with larger
  limits continues", and resume is slice 6, so the number is left for it rather than reused for
  something else. `LIM04` covers active time within one run now and gains its across-resume half there.
- **A note is a new record entry kind**, `{ kind, text }`, so the cost note is data rather than a text
  marker, and later notes do not need a format change. Replay skips it, and a reader that does not know
  the kind skips it too. `run-record.md`'s entry table says so.
- **A bad limit fails before the header is written.** `bad_request`, one `run_start`, one `error`, one
  `run_end`, and storage is empty: "fails fast rather than parking a run before it starts" is only true
  if there is no record that looks like a run.
- **The harness moved to `run-harness.testing.ts`** in its own commit. Step 2's slices each get a test
  file (limits, stop, retries, stuck, resume) and they all build a run the same way.

## Step 2, slice 1, 2026-11-17

**Start a session at [`README.md`](README.md), "Where the last session stopped".** In short: step 1 is merged,
step 2 is on `feat/step-02-limits-retries-resume` at `8b3ce75` with only slice 1 done, no pull request yet, and
slice 2 (limits, `LIM01` to `LIM07`) is next, with its design already in the step document.

- **`MessageLabel` already allows `reminder`.** Slice 5 needs it for the stuck safeguard's nudge, and it is a
  union member with no writer yet, so a reader of the record may find one before anything writes one. It is
  here rather than removed so slice 5 does not have to change the format twice.

- **Lumen is finished in Lattice**, so step 5's Lumen half has its dependency; it still needs a published
  Lyra, which step R provides.
- **The cap cuts one field per entry, and says which.** Details go first and whole (they are for a person,
  never the model), then the largest text field is cut and restored to as much as fits. If a second field
  has to be cut too, the marker names the text field and `droppedBytes` is the total, because a record
  losing two fields still has to say what happened in one line.
- **An entry whose structure alone is over the cap is refused, not saved.** Thousands of calls in one turn
  cannot be cut without breaking the pairing of calls and results, and a record that no longer loads is
  worse than a run that fails with a reason. It is the one case in REC04 that gives up, and it says so.
- **The task input is checked before the header is written.** "Nothing is saved" has to mean nothing: a
  refused input leaves the storage empty, so a later resume finds no record rather than a header with no
  message.

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
