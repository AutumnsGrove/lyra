---
title: "Lyra implementation notes"
status: planning
category: features
---

# Implementation notes

The handoff file (see [`README.md`](README.md)). Judgment calls, surprises, and loose ends from building, newest first. One short entry each, headed with the step and the date, saying what was chosen and why. Autumn reads this before she reads a diff.


## C slice 1, the shell that deploys, 2026-11-25

- **`run_worker_first` on `/v1/*`, not a second deployment.** With assets and a single-page fallback, a
  request that matches no asset becomes `index.html` — including `/v1/commands` — so the protocol path has to
  be claimed before the assets layer sees it. The alternative was an `ASSETS` binding and a Worker that routes
  every request itself, which is the same routing written in a place a config already covers.
- **The page is one static `public/index.html`, not SvelteKit yet.** The plan puts the SvelteKit app in `web/`
  built into `dist/web`, and that arrives with the page that needs it (slice 2). Adding SvelteKit in slice 1
  would have meant a build step and a dependency before there is a second thing to render, and dependencies
  need an allow-list entry and a decision.
- **The shell ships a placeholder model that calls `finish`.** Slice 1 has to prove the door, the object, the
  record and the protocol on a real deployment, which needs a run that completes, and the real model is slice
  2's job. It reports zero tokens and no cost on purpose, so slice 7's "a reply with no cost marks the day
  unpriced" rule has something honest to read rather than a placeholder pretending to be priced.
- **`docs/playground.md` starts now, with two rows.** `matrixcheck` fails a test that cites an ID no spec
  defines, and the alternative — test names with no row — is the drift the rule exists to stop. The row table
  was planned for slice 8; it is cheaper to grow it per slice than to write eight slices of rows at the end.
- **The playground's bundle has its own budget entry, 60 KiB.** Measured 45.6 KiB gzipped at slice 1. It is
  separate from the example Worker's 48 KiB because the two measure different promises: the example proves the
  library is embeddable, the playground is the thing that pays for its own imports.


- **A test that imports the package by name needs the runner to resolve source.** The slow half of the gate
  runs no build, which is the point of the split, so the first version of the playground's tests imported
  `@autumnsgrove/lyra` and resolved `dist/` that the CI job never made: green locally, red in CI. `vitest.config`
  now aliases every entry point to `src/`, the way both tsconfigs already do.
- **`importcheck` covers host apps now, and was run against two deliberate violations.** A `node:fs` import and
  an undeclared `yaml` import in `packages/playground/src/model.ts` each failed with the right message before
  the pass was trusted (decision 156).
- **The routing that keeps the page off `/v1/*` is configuration, so it gets a test that reads it.** `PGS03`
  parses `wrangler.jsonc`; removing `run_worker_first` would otherwise break every protocol call on a deployment
  with the gate still green (found in review).
- **`Session`'s own delegation is untested until slice 2, and the PR says so.** What one can check in Node is
  that the entry exports the class the config binds; the six one-line forwardings — `fetch`, `alarm`, the three
  socket callbacks, and the build that hands the adapter its context and env — need a real Durable Object, so
  the workerd test belongs with the slice that gives a session a real model to talk to. Slice 1's end-to-end
  proof is the by-hand deploy, and slice 7's smoke job is the standing one.


## #77, a dropped field that made the entry fit, 2026-11-25

- **The marker is part of the cap, so the issue's three caps still refuse.** #77 reproduced the
  over-refusal at caps 237, 250 and 280, and REC04's clause is what answers it: a refusal is right when the
  *structure, counting the truncation marker it would need,* is over the cap. For that turn the trace-less
  entry is 237 bytes and the marker costs 44, so 280 cannot hold the note that says what went — the fix is
  the range above it (281 to 313 was refusing a 281-byte save), not those three caps. The boundary is now
  280 refused, 281 saved, and a sweep asserts a refusal never hides a save.
- **The same window was open for a dropped `details` block, and review found it.** That drop happens
  before the loop and still measured the widest number a marker could hold, so a tool message with empty
  content and a 1 KB `details` was refused for twelve caps (165 to 176) whose real marked line is 165.
  It now measures the marker it would really carry, like the loop's own gate, and its test fails without
  the change. The lesson for the sweep: one entry shape proves one shape.
- **Two tests had pinned the over-refusal as correct, and one of them was a corpus case.** At cap 200 a
  tool result with a 4 KB body now saves with `content` gone and a marker saying so, where it used to refuse;
  REC04 says content is content and only structure is refused, so the old expectation was the bug wearing a
  test name. The over-cap assertion those tests existed for is kept — it is the one that catches a line over
  its cap.

## Review pass, 2026-11-24

- **Workflow actions are pinned by tag.** `release.yml` runs `softprops/action-gh-release` and
  `pnpm/action-setup` by tag in a job with `id-token: write`, and `pi-review.yml` calls a reusable workflow
  at `@main`. The two third-party actions are pinned to commit SHAs (Autumn's call, 2026-11-24); the
  `actions/*` ones stay on tags and `pi-review` stays on `@main` because Autumn owns it, so a change there
  reaches every repository that uses it without a bump.
- **A detached promise needs its own catch.** The alarm's re-follow of the sockets is not awaited on purpose,
  which is exactly why nothing above it can catch what it throws; CFL27 is the test, and it needs `process`
  declared locally because the project has no Node types.
- **A streamed request body cannot be built from the declared platform types.** `platform.d.ts` types a
  request body as a string, so the router tests attach a stream to a request after it is made, and show an
  early stop through the stream's `cancel` rather than by counting pulls.

## Playground prerequisite 2, a conversation scenario (#73), 2026-11-24

- **A "second run" is a segment of the first.** Issue #73 and the playground plan both say two runs in one
  session, and the domain says otherwise: a session owns one record and one run id, so a follow-up continues
  that run as a new segment (decision 44; the runtime refuses a record from another run with `the record
  belongs to another run`). The file keeps that vocabulary — `follow_up:` and `answer:` steps — and the row
  says `resumed` segments rather than rival runs, because that is what a client sees. It also means
  `ScenarioOutcome.results` is one entry per step, not per new run.
- **The scripted model answers by position in the conversation, not by call count.** A resumed segment's
  script has to begin where the record left off, so `runScenario` pads each step's turns by the assistant
  messages already saved, and the workerd harness lays the segments end to end. The first version of the
  scenario file gave a segment one turn where it needed two (a tool call and the reply after its result),
  which only the HTTP and socket levels caught: in-process padding hid it.
- **The wire levels drive the steps as commands, not as a shortcut.** HTTP sends `ui_response` and
  `follow_up` on one open event stream, and the socket sends the same frames on the open socket, so a
  conversation file proves the protocol carries a conversation rather than proving the testkit can. The open
  stream matters: a segment that ends quickly sent its live-only events before a per-segment stream had
  attached, which is how the missing turn first looked like a bare `failed` with no error on the wire.
- **Padding is for the conversation-position model only.** `pi-review` found that a file declaring
  `compaction:` is scripted by sequence position, and each segment's model starts at its own turn 0, so
  the padding a resumed segment needs in position mode was served as that segment's replies: the run had
  to be nudged with a reminder before it read its own script. The padding is now skipped when a file
  declares compaction, which is the one place the two modes differ. The first test for it passed either
  way, because a nudge still ends `done`; the assertion that catches it is that the record holds no
  `reminder` entry.
- **The step types are public on purpose.** `ScenarioRun`, `ScenarioAnswer` and `outstandingRequestOf` are
  on the testkit's surface rather than internal, because decision 67's whole point is that a host runs the
  files through its own adapter: without them, Lattice would re-implement the request scan and the two
  copies would drift (found in review on #78). `abort_after` with `runs:` is refused instead: one
  controller is aborted once and stays aborted, so every later segment would begin stopped.
- **`answer:` has no way to name a request id.** A file cannot guess a 128-bit id and does not need to: the
  step answers the request outstanding in the record, which `outstandingRequestOf` finds. The bad case is
  therefore a malformed answer (SCN09), while an answer with nothing outstanding is reported as a problem
  naming the step.
## Playground prerequisite 3, `message_end.reasoning`, 2026-11-24

- **The live event is announced from the fitted entry, not from the reply.** `message_end` used to carry
  `text` and `toolCalls` exactly as the adapter reported them, while the entry saved beside it had been
  through `fitEntry`. For `reasoning` that difference is the whole point of EVT10: the trace is cut to fit
  the entry cap, and announcing the raw string would put more on the wire than a reload can show. `append`
  became `fitAndAppend`, handing back what was saved; `append` keeps its signature so the other seven
  callers do not change. This is recorded in the event's own comment rather than as a decision, because it
  is the rule EVT10 states and not a choice a later slice may revisit.
- **`text` and a call's `arguments` have the same hole and are left alone, on purpose.** Both can be cut by
  `fitEntry` before the same event announces them, so the live event can still show text or arguments the
  record does not hold. The fix is not one line: the run also *executes* the raw calls, so making the event
  match the save decides which arguments run and what a resume replays, and that is a choice rather than a
  correction. Written up as issue #75 with the rows it needs.
- **The rows are in `docs/protocol.md`, not `docs/core-loop.md`.** The plan named both; an event's rows live
  with the other events (EVT08 to EVT10), and the plan now says so. The client-visible half is
  `scenarios/reasoning-trace.yaml`, which runs at all four levels rather than being asserted only against
  the core's `RunEvent`.
- **`pi-review` found that `""` still reached the wire, and the fix went into the record.** With a text and a
  reasoning both over the cap on their own, `fitEntry` emptied the reasoning whole and left `reasoning: ""`
  with the marker naming `text`, so the live event, the replay and `get_messages` all claimed an empty trace
  (EVT09). The first fix would have been to skip `""` in the two event spreads, but `get_messages` is a
  client surface too, so the record stops claiming it: a field the record does not require is removed when
  it loses everything, which is what `fitEntry` already did for a tool result's `details` (RECTRUNC, REC02).
  The event spreads also treat `""` as absent, because a record written before this rule can still hold one.
- **An empty trace is not saved at all, so the live spread has no `""` branch.** The second review round noted
  the live guard could not fail: with `fitEntry` removing a whole-dropped field, the only source of `""` on
  that path was an adapter reporting one, and `run.ts` was saving it. It now skips an empty `reasoning`
  instead, so the record never claims an empty trace, and the live event needs no empty check at all — only
  the projection keeps one, for records written before this rule (EVT09).

## Slice B, parallel tool calls, 2026-11-24

- **The grouping lives in `runBatch`, the concurrency in `executeTools`.** The policy check is in
  `runBatch` (`deny` and `ask` need `canAsk` and `saveRequest`), so it is also where a run of eligible
  calls has to be recognised; `executeTools` then only knows "run this many at once and save in order".
  Splitting it the other way would have needed a policy callback inside the executor, which is the kind of
  seam that drifts.
- **A chunk, not a sliding window.** The cap splits a group into consecutive chunks, so the same script
  always saves the same record. A window would start the next call the moment one finished, which is
  faster and makes the save order depend on completion order.
- **The second question in one chunk is answered, not dropped.** `runBatch`'s `waitingRequest` is a single
  slot; asking twice in one chunk would leave the first request unanswered and unlisted. The second call
  gets an error result saying a question is already open, so the record stays paired. Decision 141's "an
  ask stops the batch" is unchanged: a policy that asks is a barrier.
- **A killed group resumes one call at a time.** A resume answers the last reply's calls that have no
  result individually, which is slower for one batch and keeps one resume path. It also means a call that
  ran but was not saved is answered "outcome unknown" unless the tool says `safeToRepeat` — which is the
  same rule decision 24 already had, and why a tool with any side effect stays out of a group.
- **The scenario vocabulary needed `ask`, `parallel` and `max_parallel_calls`.** Two of issue #67's
  scenario cases cannot be written without them. The one thing that bites: the protocol spells a request
  `ui_request` and the core spells it `request`, so a scenario cannot name that event at both levels; the
  question scenario pins the order in the record instead. The cap scenario asserts the record only, not
  the start times, because the runner's `advance(1000)` step is a test detail rather than a promise.
- **Two things review caught that the tests were shaped not to see.** `maxParallelCalls` reached the
  resume path and not `start`, because `runtime.ts` builds two setups and only one gained the field; both
  now spread one `fromDefinition`, and a test starts a run through the runtime rather than `runTask`.
  And a `done` tool inside a chunk let its siblings through: every call is started before any result is
  saved, so the calls behind it have to be answered the way the serial path answers them (LOOP25, and
  LOOP24's script now includes a tool that ends a run mid-group). The property also compares the ending,
  not only the record, because a `done` followed by three same-named calls parks as stuck — the
  safeguard counting the three "already finished" answers — and a serial run parks the same way.
- **`starts` in an events assertion includes every `tool_start`, including the barrier after the group.**
  Three of the new tests failed first on that, not on the behaviour, which is worth remembering when
  writing the next one: slice to the group before comparing timestamps.

## Step 8, slices 1 to 3, 2026-11-21

- **WebSockets under Durable Objects need their own vitest config**, as decision 101
  said: `vitest.ws.config.ts` runs one worker with `isolate: false`, and
  `vitest.workers.config.ts` excludes the socket files so they do not also run in the
  mode that cannot carry them (found in review: they ran twice).
- **The workerd socket harness has one wall I could not get past.** Two behaviours the
  step document asks for hang in this harness rather than failing:
  eviction *mid-run* with a socket open, where `runDurableObjectAlarm` never settles,
  and a backed-up reader, where the client's `bufferedAmount` never grows enough to
  trip the cap and the close never comes. Both worked on paper and neither is in the
  tree: WSK13 and WSK15 are not written, and the two-minute hang each leaves behind
  is worse than a failing assertion. What *is* covered: an eviction with a socket
  open and a parked run (WSK12), the attachment's contents and size (WSK14), and a
  reconnect catching up from the record (WSK08, WSK09). The backpressure code
  (`bufferedAmount` against a 1 MiB default) is in and untested here; the honest next
  step is to probe it against a real deployment, or to find the harness option that
  makes the client back up.
- **`getWebSockets()` is empty after an eviction in this harness**, even though a
  frame still reaches the handler's `ws` and a response still reaches the client. So
  the re-follow after a wake is driven by the frame itself (`watch(socket)` before it
  is handled), not by the platform's list, and a socket that never sends anything
  after an eviction will not get live events until it does. That is also why WSK14
  reads the attachment's `seq` as a cursor rather than as the exact last frame: the
  wrapper `getWebSockets()` returns does not show the handler's writes.
- **`webSocketClose` has to answer the close.** Cloudflare's hibernation docs require
  it, and the tests never awaited the close event, so nothing caught it missing.
- **A socket's `hello` starts the events**, so a test that wants to see a *live*
  event has to drain the replay first; two tests passed on replay alone before the
  review caught it.

## Step 8, wrap-up, 2026-11-21

- **The example Worker's ceiling moved to 48 KiB** (decision 143): passing the three
  hibernation handlers through crossed 44 KiB by 91 bytes, and there is nothing to cut
  in three delegating methods.
- **`main`'s gate was red for everyone** when the two Claude review workflows landed
  unformatted: `pnpm format` checks workflow files, and it is the gate's first step.
  Fixed in pull request #31 rather than inside this branch, so the two changes stay
  separable.
- **`getWebSockets()` is empty after an eviction in this harness**, so the re-follow is
  driven by the next frame on a socket, not by the platform's list. A socket that
  never speaks again after an eviction gets no live events until it does; the record
  is the catch-up either way.
- **`webSocketClose` has to answer the close**, which Cloudflare's hibernation docs
  require and the tests never awaited, so nothing caught it missing.
- **The plain-GET 500 was the front door's fault**: forwarding a `GET /v1/ws` that did
  not ask to upgrade made workerd throw. The header is checked before a pair is made.
- **The gate**: 521 Node tests, 50 workerd tests, 31 socket tests, 15 fuzz/property
  targets, `matrixcheck` 343 rows with none unbuilt, package 133,514 B of 180,224 B,
  the example 45,147 B of 49,152 B.
- **Not done, and said so in the PR:** WSK13 (eviction mid-run with a socket open) and
  WSK15 (a backed-up reader) are unwritten because both hang in this harness;
  `pnpm lyra --transport ws` is a dev tool and is not in the gate.

## Step 8, review round 3, 2026-11-21

- **Events started before the hello exchange.** The frame handler followed the
  socket on every frame, so a refused command or a bad hello still began the stream.
  It follows only a socket that has greeted, which the hello itself sets.
- **The greeting wrote back a stale cursor.** The attachment is read at the top of the
  handler, before the replay the watch starts; writing `greeted: true` from that copy
  put `seq` back to where the replay began, so a wake would replay the record the
  client already had. The greeting is saved before the watch now, and a test evicts
  after a replay and asserts the next frame brings no events.
- **Two ids collided across an eviction in the test class.** It used `counterIds`, and
  a rebuilt object restarted the counter, so an appended entry took an id the record
  already held and the active path broke — which looked exactly like "the events
  never arrive" and cost an hour. The test class uses `systemIds` now, as a host does.
  Worth remembering: anything that can be evicted cannot count.

## Approvals, review round 4, 2026-11-21

- **Every command that appends claims the record now**, not only a decision and a run
  the session continues. The gaps were the ones that do not look like "start a run":
  `respond` (the `ui_response` path, which is the primary write of this slice),
  `wake`, and `compact`. Two of any of them caught mid-write chain from the same
  parent, and the branch that lands second falls off `activePath` — silently, because
  every command is told `ok`. The tests hold an `append` open to make the window real
  rather than hoping a scheduler agrees.
- **`runtime.active()` is not a lock.** It only knows a run after `track`, so a resume
  that is still reading the record is invisible; the session's own claim is what
  closes that. Worth remembering for anything else that writes the record.
- **`reserveIds` has to reserve every prefix, not just `e`.** A record's request ids
  and proposal ids come from the same source, and a resume that only skipped the entry
  counter handed out `prop1` twice — the second proposal could never be decided,
  because everything that finds a proposal finds the first.
- **A sentinel made `resume.ts` binary.** `"\0never"` in a Python patch became a real
  NUL, git called the file binary, and the diff was unreviewable while every check
  passed. Seeding the map directly is what the code needed anyway.

## Approvals, wrap-up, 2026-11-21

- **The slice has a letter, not a step number**, because `first-slice.md` puts
  approvals under **Later**. Its done-when is the protocol's own rows plus the ones
  it added to `approvals.md` and `consumers.md`, and it stays additive so step 8
  does not wait on any of it.
- **`canAsk` is the seam decision 35 needed.** False is a headless runner and a
  session sets it true, which meant two runtime constructions (the session's and the
  Cloudflare session object's). I missed the second one and the workerd scenario
  showed it: the run did not park, because nothing could deliver the question and it
  was denied. Worth remembering: anything a session sets has to be set where a
  session is *built*, and there are two such places.
- **A tool that says nothing is allowed.** Every tool built before this slice is
  silent; silence meaning "ask" would have stopped every existing recipe at its first
  call. A recipe can set its own default for silent tools.
- **The answer is an entry, and it stops being live once its call has a result.**
  That single rule fixed three findings at once: a wake no longer continued a run
  parked for a limit, a `failed` record no longer spent a turn before saying so, and
  an old approval could no longer settle a later call that reused a call id.
- **A question's answer is the call's result**, saved as a `tool_message` whose
  `details` carry the text or the chosen ids, so `apply` and a replay see the same
  shape. The branch that reads it is chosen by the request's kind, not by whether the
  client sent a `text`: an approval answered with a stray `text` must still run.
- **An ask stops the batch.** The calls behind it have not run and must not run while
  a person is deciding; the first version let them, which is exactly the class of bug
  the "never split a call from its result" rule exists for.
- **`ui_response` names the request with `request`**, not Nova's `id`, and carries
  `session` because HTTP has no connection to name it. That is a deviation from
  decision 85's Nova shape, recorded in decision 140 with the reason.
- **A proposal ends the run** and is decided once; the payload is checked twice (the
  tool's parameters and the recipe's payload schema), because the toolbox's parameter
  check only knows it is JSON.
- **The gate**: 511 Node tests, 50 workerd tests, 15 fuzz/property targets,
  `matrixcheck` 330 rows with **none unbuilt** — every row written during planning is
  now built.

## Approvals, review round 1, 2026-11-21

- **An answer stopped being live too late.** `readResumeSeed` kept the last request
  and its answer for the whole record, so any record that once had one always had a
  decision, and `recordedOutcome` was never consulted again: a wake could continue a
  run parked for a limit, a `failed` record spent a turn before saying it had failed,
  and an old approval could settle a later call that reused the same call id. The
  seed now clears both once the request's call has a result, which is the moment the
  answer has done its work (APR05, APR07).
- **The timeout's wake was lost on the second park.** `run_end` cancelled the alarm,
  and a resume that parked again is a new handle that never saw the `request` event,
  so nothing re-armed it and the request could never expire. A park for
  `waiting_for_person` now keeps its alarm: that wake is the only thing that ends the
  wait (APR11).
- **My first test of the stale answer proved nothing**, because it wrote the answer
  into the array of lines it resumed from rather than into the storage a later resume
  reads. `answerWith` now writes it where the session would, and the test fails on
  the reviewed head. Worth remembering: a resume reads storage, not the caller's copy.
- **`request_answered` was missing from the record generators**, so RCD06's round
  trip, RCD07's loader fuzz and the projection property never saw it. The generator
  carries only `timedOut: true` or absent, because a present `false` is normalised
  away and would break the round trip.
- **Two release-notes tests timed out under the bigger suite.** They build a git
  fixture and spawn the script, so five seconds was measuring the machine; the file
  now gives each test 30 seconds. Nothing was skipped, and RN07 still asserts on its
  own deadline.

## Step 7, review round 1, 2026-11-21

- **Round 3: the live path never dropped the pre-cut count.** After a live
  compaction `lastInputTokens` still held the reply from before the cut; the next
  reply usually replaces it, but a request whose retries run out and a recipe with a
  `fallbackModel` `continue` back into the trigger with nothing new, and the run
  then failed `input_too_large` on a conversation that no longer existed. The
  compaction path clears the base where it rebuilds the view, which is the same drop
  the resume seed makes, so the two sides agree. CMP25 pins it: a compaction, four
  retryable failures, a fallback, and `done`.

- **Round 2: the first guard threw away a current provider count.** Comparing the
  view's own estimate with the window fixed the resume case and broke the honest
  one — a model reporting more input tokens than the window over text that estimates
  far smaller (dense JSON, base64, CJK, and `keepTokens` at or over the window) now
  got the request sent instead of the stable `input_too_large`. And with the seed's
  base dropped, `lastInputTokens + since-last-reply` counts only from the last
  assistant message, so the summary and the kept steps were invisible to the
  trigger. One change fixes both: the estimate is the whole view when there is no
  base, and the base plus what arrived since when there is, with the guard back on
  that number. Two tests pin it — a reported 5000 into a 600-token window with
  nothing to cut fails plainly, and a resume whose summary alone is over the window
  reports the view's own thousand tokens rather than the kept step's hundred.

- **A resume after a compaction could fail `input_too_large` although the view fit.**
  `lastInputTokens` came from the last reply's reported input tokens, but after a
  `compaction` entry that number describes the conversation *before* the cut. Two
  fixes, both test-first (CMP24). The seed now hands back a base only when no
  compaction came after the last reply, so the estimate after a cut is the view's
  own. And the `input_too_large` branch compares the real conversation's estimate
  against the window rather than the reported base, so it cannot claim that
  compacting cannot help when a compaction already did. The guard is the one that
  shows: right after a cut the view has one step, so a stale base could only spend a
  `chooseCut` call on nothing. It still matters with a big `keepTokens`, where a cut
  can keep several steps and a stale base would immediately compact again.
- **A summary's cost vanished on resume**, which contradicts CMP14 and LIM06: the
  seed collected assistant usages only. It now collects a compaction's `usage` as
  well, kept apart from the assistant usages so it never becomes the input base, and
  both the run's totals and `get_state` add them (CMP14's resume half).
- **The resumed view was built from every loaded entry, not the active path.** A
  record whose chain the loader reports as broken has entries the conversation does
  not contain, so the model was shown the pre-break history while `get_messages` and
  `replayConversation` showed the chain. `buildView(activePath(...))` makes the two
  the same conversation (CMP23).
- **`cutText` could return more than the cap it was given** when the cap was smaller
  than the marker itself: the binary search stopped at zero and returned the marker
  alone. The cut is now silent in that case — a result over the cap a tool set is
  worse than one without a note — and a cap that is zero, negative or fractional is
  not a cap at all, so the next one out applies instead of emptying the result
  (CMP18).

## Step 7, wrap-up, 2026-11-21

- **A testkit rule met compaction and broke.** The scripted model chose its turn by
  the assistant messages in the request, which is what makes a request re-asked after
  a kill get the same answer. A compaction folds older turns into one summary, so that
  count goes *down* and the script replays a turn it already answered. Both fakes now
  take `position: "sequence"` (with `startTurn` for a resumed script); the conversation
  rule stays the default. A summary request is told apart by `ModelRequest.purpose`,
  and over the wire — where no such field travels — the fake server reads "no tools"
  as a summary, and only when it has summaries scripted, so a server without them
  behaves exactly as it did (decision 136).
- **`chooseCut` counts content, while the trigger counts what the provider reported.**
  A fake that reports 800 input tokens over a 400-character history can fire the
  trigger and still have nothing to cut, and both halves are right: the trigger is
  about the provider's number, the cut is about the text. The long-run test reports
  tokens that stay under the window, which is also all a provider can do — a number
  over the window would have made the run fail `input_too_large`.
- **The default reserve is bigger than a small test window.** With a window under
  16,384 and no `reserveTokens` the trigger is always on, and with a tiny `keepTokens`
  that means compacting every turn. That is decision 135's arithmetic working as
  written, not a bug, so a test that sets a small window sets a reserve too.
- **The compaction entry points at an entry that already exists**, and it is written
  at the gap *after* the entries it keeps. A kill between the summary and the entry
  leaves no trace; a kill after it leaves a complete compaction whose pointer is
  already on the record. The first attempt pointed at the entry the next turn would
  write, which would have lost the kept steps if a kill landed in between.
- **The view keeps only message-bearing entries.** Statuses and notes are in the
  record and not in the view, so `replaces` counts messages. The first version kept
  them, and a resumed run folded one more entry than an uninterrupted one, which is
  exactly what CMP21 caught.
- **A summary over the entry cap is fitted before the view is rebuilt**, so the model
  reads the summary the record holds rather than the longer one it wrote. Without it
  a live run and its own resume would show different summaries (CMP20).
- **A summary that is empty parks; one that fails retryably is retried.** An empty
  answer is not an outage, so a retry would spend another call to be told nothing
  again. A person's `compact` answers an error instead, because there is no run to
  park (decision 137).
- **What a summary loses:** an old tool result over 8,000 estimated tokens is cut
  before it goes to the summarizer. The record keeps it whole, and a tool's
  `currentState` restores exactness where a recipe can supply it, so the detail that
  goes is the detail nobody asked to keep (decision 136).
- **The gate at the wrap-up** (before the three review rounds, whose fixes added
  rows and tests): 458 Node tests, 48 workerd, 14 fuzz/property, coverage 91.76%
  statements and 85.33% branches, package 116,878 B of 180,224 B, the example
  36,328 B of 45,056 B, and `matrixcheck` 309 rows (299 tested, 10 unbuilt, all
  approvals and proposals). The merged head is 465 Node tests, `matrixcheck` 312
  rows (302 tested), coverage 91.74% and 85.34%, and the package at 117,873 B; the
  README's resumable-state section carries those. No ceiling moved: step 7 added
  about 12 KiB gzipped to the package and 5 KiB to the example, both well inside
  decisions 129 and 134.
- **The long run's tool results are the timeline's small ones.** "Big results" is
  covered where it bites — CMP16 for the summary's own cap, CMP18 and CMP19 for a
  result cut on arrival and a state that needs the part that was cut — rather than by
  making the timeline's page bulky, which the recipe does not do. Worth revisiting if
  the real timeline's results turn out large.

## Step 6, fix after merge, 2026-11-21

- **CI caught a bad fuzz property the same hour the step merged, and the seed is why.** The generator
  could put a `type` of its own into the bag, which replaced the frame's `type`; the property then
  asserted the frame was always accepted, so one seed failed. The generated fields now go in before the
  envelope, so `type`, `command` and `id` always win. The assertion that the frame is accepted stays: with
  the envelope last it can only fail if the decoder regresses, which is exactly the guard this target sits
  over (found in review; the first fix dropped it and left a dead refusal branch). The lesson stands: a
  property that can fail for a reason other than the one it names is a property that has not been read.

## Step 6, review round 1, 2026-11-21

- **A concurrent `start` could start two runs on one record.** The session read the record, found it
  empty, and let `runTask` write the header a few awaits later, so a second start in that window also
  saw an empty record. Both findings were real; both were fixed test-first. The session now remembers
  the run it has just started (`started`), checked after the read and before anything that awaits, so
  two overlapping keyed starts answer the same run and a different job is `conflict`. Two tests in
  `session.test.ts` reproduce it with `Promise.all` and assert one header.
- **The Worker's routing disagreed with the handler's own answers.** `POST /v1/ui_response` and unknown
  paths never reached an object, so the deployed surface answered 404 where HTP07 says 501 and 400 where
  HTP08 says 404. `createSessionWorker` now mirrors the handler for the routes that need no session,
  including the version header. The two new workerd tests assert the Worker's answers for those routes.
- **The claim in the review about the record was checked, not assumed**: two headers really did land.
- The first attempt at the test asserted the header immediately after the command answered, and failed
  because the header is written a moment later. That is the same window the bug lives in, which is why
  the test now waits for the run to end before counting headers.

## Step 6, slice 6, 2026-11-21

- **Every scenario file runs over HTTP now**, through a Durable Object with SQLite and an alarm: SCN05 in
  the workers suite. A file's scenario is loaded into the object before the run (test support, the way
  step 4's fixture is configured); after that the test only speaks the protocol.
- **A live-only event can be missed by a client that connects a moment late**, and the abort scenario
  showed it. `tool_start` is not in the record, so the session drops it when nobody is watching yet, and
  an HTTP client that opens its stream just after `start` can miss it. The runner therefore aborts at the
  turn's end, which is the same moment on the wire, rather than at an index into an event list that
  includes an event the wire may not deliver. This is decision 86 working as intended rather than a bug,
  but it is the first place it is visible, so `notes.md` is where it goes.
- **The example Worker is a real small server now**, so its bundle grew from 22.4 KiB to 31.2 KiB and its
  ceiling moved to 44 KiB (decision 134) rather than being cut.
- **`pnpm lyra` imports the built package's line reader** from `dist`, so `pnpm build` has to have run
  once; the script says so. `pnpm dev` runs `wrangler dev` against the example, with a local-only token
  and tenant in `wrangler.jsonc`. Neither is exercised by the gate (a dev server is a long-running
  process); the example's build, its route and the protocol it serves are.

## Step 6, slice 5, 2026-11-21

- **The tenant is on the record's header, and the object is the one that checks.** A keyed session id is
  `idFromName("<tenant>:<key>")`, so the id itself leaks the tenant; the header is what a restart can
  trust, and the object refuses `not_found` before any command runs. `RCD10` is the header row, and an
  older record without the field still loads.
- **The Worker routes by reading the frame.** `POST /v1/commands` names its session in the body, so
  `createSessionWorker` parses just enough (session, key, command name) to pick an object, then forwards
  the request with its headers so the object's own token door still applies. A request that skips the
  Worker is refused by the object, not honoured.
- **The trusted door answers with the frame.** `send({tenant, frame})` runs the same handler with a
  tenant fixed by the caller, so a service binding's entry point needs no second parser. Making it an
  RPC method meant the test class had to extend `DurableObject` rather than implement the legacy
  interface; the first attempt failed workerd with exactly that message.
- **Not done, and said so in decision 133:** the example Worker does not mount the session object or a
  real `WorkerEntrypoint` service binding yet. The routing and the door are tested through a test
  Worker that does both. The step document's "verify it against Cloudflare's docs" is still open for
  the example, which is the scenarios/dev-client slice's company.
- **The gate**: 425 Node tests, 33 workerd, 10 fuzz/property, `matrixcheck` 284 rows (273 tested, 11
  unbuilt), package 104,583 B of 180,224 B.

## Step 6, slice 4, 2026-11-21

- **The HTTP tests were written first and watched failing**, against a handler that answered 501 to
  everything, then filled in.
- **A host's `not_found` message is replaced, not passed through.** A keyed session's id is
  `idFromName("<tenant>:<key>")`, so a host saying "there is no session acme:job-1" would tell another
  tenant what it guessed. The handler answers "there is no such session" instead, and `ACC01`'s test
  asserts the tenant name is not in the answer. Decision 132 records it.
- **A replay arrives in one burst, so a small queue cap drops a client that is reading.** The drop rule
  counts what is queued for the stream, and the whole record can arrive before the first read. That is
  acceptable (the client reconnects and gets the rest), but it means the two HTP06 halves use different
  caps: one to prove the drop, the default to prove the catch-up. Worth a second look if a real client
  ever sees itself dropped on connect.
- **The token comparison is by digest.** Comparing strings byte by byte leaks a token's length, and
  `crypto.subtle` is web-standard on both runtimes, so each candidate's SHA-256 is compared with no early
  exit. The door is a callback, so slice 5's Worker can build it from the Secrets slot.
- **Rows**: HTP01 to HTP08 are new; ACC01 and ACC02 came off `unbuilt-rows.json`. 11 protocol rows are
  still unbuilt: approvals, proposals and the reconnect-row EVT05 that needs the second-level scenarios.

## Step 6, slice 3, 2026-11-21

- **The session needed a core seam, so it got one with a test.** CMD05 wants a follow-up to start work
  when nothing is running, and a resume could not append a message. `ResumeRequest` now takes
  `followUp` (row RSM08): a person's resume carrying one continues a record that ended `done`, `failed`
  or parked, and a wake never does. The run writes the message after `resumed` and after any unanswered
  call is answered, so a person's message never lands between a call and its result.
- **One session is one record, so it is one run id.** The runtime's resume refuses a header naming a
  different run and the header is written once, so "a new run in the same session" is a new segment of
  the same run. Decision 131 records it, along with the answers the commands give when they cannot do
  what was asked (`not_found` for a task the host does not run, `conflict` for a second `start` without
  a matching key, `busy` for a `prompt` during a run).
- **Events are re-read from the record after every write.** That gives a client exactly what a reconnect
  would replay, with the same `seq` and order, and leaves the live-only events (`retry`, `tool_start`)
  as the only ones that travel alone. The cost is reading the whole record per write, which for a long
  run is a lot of SQLite; the alternative, trusting `seq` on the live events, would be a second source
  of truth for what the record says. Worth revisiting in step 7 if a timeline run reads slowly.
- **`get_messages` is capped in entries and in bytes.** The byte cap defaults to the entry cap, so a
  page always fits one line, and the test sets a 600-byte cap to prove a page stops before passing it
  rather than only counting entries.
- **The gate**: 413 Node tests, 28 workerd, 10 fuzz/property, `matrixcheck` 270 rows (257 tested, 13
  unbuilt: approvals, access and the HTTP surface), package 97,299 B of 180,224 B.

## Step 6, slice 2, 2026-11-21

- **The tests came first this time.** `events.ts` was written as a stub that returned nothing, the
  nine projection tests were watched failing on empty arrays, and then the projection was filled in.
  That is the loop the README asks for, after slice 1's own note said it had been skipped.
- **The projection is a function of the whole record, not of one entry.** The step document names
  `eventsFor(entry, seq)`, but three of the things a client needs are not on a single entry: a
  tool's name (only the assistant message's call knows it), a turn's number, and the usage a
  `run_end` reports. So the public shape is `projectEvents(entries, {session, run})` plus
  `eventsAfter(events, seq)`, and the fold is what makes a replay equal to what a watcher saw.
- **Two rules moved out of `run.ts` so there is one copy.** `createUsageTotal` is now
  `core/usage.ts` and `parkedReasonOf` (with its list) is in `core/events.ts`; the live loop and the
  projection both call them, which is what stops a replayed total or parked reason from drifting
  from the live one. Decision 130 records it.
- **The property test found the property's own mistake before the code's.** "Nothing after a
  `run_end`" is true of a run but not of any record the format allows: fast-check produced a
  `fallback` entry after a `failed` status, which a damaged host could leave. The projection is
  faithful rather than tidy, so the property now says one `run_end` per terminal status, matching
  each one's `seq` and reason.
- **`EVT01`, `EVT02`, `EVT03` and `EVT06` came off `scripts/unbuilt-rows.json`** with their tests: 22
  protocol rows are still unbuilt, all of them commands, approvals, access or the HTTP surface.
- **The gate**: 399 Node tests, 28 workerd, 10 fuzz/property, `matrixcheck` 266 rows (244 tested),
  package 92,834 B of 180,224 B. The ceiling has room for the session, the HTTP surface and the
  object.

## Step 6, slice 1, 2026-11-21

- **The tests came after the code in this slice, and the commit says so.** `frames.ts` and `reader.ts`
  were written before their tests, which is the one departure from the loop in this repository so far.
  Rather than claim a red that did not happen, each test was checked against a deliberate mutation: an
  ignored cap fails `FRM01`, and a wrong code on a bad line fails `FRM02`. Both were restored, and the
  full suite is green. Slices 2 onward go back to tests first.
- **The line cap is enforced on bytes and decoded per line.** Splitting on `\n` cannot cut a UTF-8
  sequence, because `\n` is never a continuation byte, so each completed line's bytes decode on their
  own and a character split across two chunks still comes out once. That is what `FRM03` pins.
- **`FRM01` came off `scripts/unbuilt-rows.json`** with its test, as the file's rule requires; 27
  protocol rows are still unbuilt.
- **The size ceiling has 1.2 KiB left** (88,910 B of 90,112 B). Step 6 still has to add `commands.ts`,
  `events.ts`, `session.ts`, `http.ts` and the Durable Object host, so the next slice that lands needs
  a decision raising it, with the reason and the real number rather than padding.

## Step 5, PR B (slices 4 to 7), 2026-11-19

- **The misbehaving model is a script, not a live generator.** Each turn is drawn up front from the
  seed, so the same seed gives the same script and a failure repeats exactly; the model is then the
  testkit's scripted one. It will call `finish`, which is what lets a run end `done` instead of only
  parking, and a run with a step limit always ends whatever it does.
- **The scenario runner learned a `makeModel` seam rather than importing the adapter.** The testkit
  may not import an adapter (`importcheck`), so the third level of decision 63 is a parameter: a test
  that wants the wire passes a factory. `SCN04` counts the calls it made, because otherwise the same
  expectations would pass through the in-process fallback and the row would prove nothing — that
  mistake was made and caught by a deliberate mutation.
- **A cassette is matched by method, URL and body, and each exchange is used once.** A retry therefore
  needs its own recording, which is exactly what a recording of a run that retried contains. The body
  is compared as JSON, not as text, so property order does not decide whether a request matches.
- **The recorder reads the body and hands it on.** A response body can be read once, so the recording
  `fetch` reads it, records it, and answers with a fresh `Response` built from the same bytes. Nothing
  downstream can tell the difference.
- **Recording and writing are split.** `recordingFetch` is in the testkit and is web-standard;
  `live/recorder.ts` writes the file and refuses one that still holds a key, since it is the side that
  has the environment. The scan runs over every committed cassette in `src/cassettes.test.ts`, which
  is why a contaminated one cannot land quietly.
- **DeepSeek V4.1 Flash is the live default, not kimi-k3.** Autumn's call (2026-11-19): kimi-k3 is
  far too expensive per quota, and `deepseek-v4.1-flash` speaks chat completions and goes further on
  the allowance. The model id was checked against the live `/models` list before the first run rather
  than trusted from the docs table, which is how a typo would otherwise have cost a call.
- **The live suite ran for the first time on 2026-11-21, on Autumn's keys, and passed.** Two real
  calls with a tool: OpenCode Go with `deepseek-v4.1-flash` and OpenRouter with
  `deepseek/deepseek-v4.1-flash-1017`. Each ended `done`, each called the tool, and each usage
  reported input tokens. The keys were read from a file outside the repository and sourced into the
  test process, so nothing was ever in a command line, a log or a diff. A second run with `RECORD=1`
  wrote `cassettes/opencode-go-one-tool.json` and `cassettes/openrouter-one-tool.json`: real bytes,
  two exchanges each, no auth header and no `set-cookie`, and the scan that CI runs passes on both.
  The synthetic `scripted-run.json` stays, because it is the one recorded from the fake server.
- **A keyless run is a skip, not a failure.** The tests are registered with `test.skipIf`, so a file
  with no keys in the environment reports two skipped tests and exits 0; the skip's reason is in the
  test's own title, because Vitest does not print a module-level `console.warn` in the default report.
- **The presets are two functions, not a table.** They differ in a base URL, a secret's name and one
  header, so a preset is those three things and nothing else; a per-provider quirks table would have
  been a fourth copy of the same knowledge (decision 127).
- **`OpenCode Go` needs its session to be required, not optional.** Its docs ask for a stable
  `x-opencode-session` per conversation, so `openCodeGo()` takes a session and a caller cannot forget
  one and quietly lose routing and prompt caching.

## Step 5, PR A, review round one, 2026-11-19

- **A stop during the secrets lookup still sent the request, and the review was right.** The
  controller and its abort listener were made after `secrets.get` resolved, so an abort that arrived
  while the lookup was in flight was added to an already-aborted signal, never fired, and the whole
  stream was read before the post-read check reported it stopped: a person's stop would still have
  spent tokens. The signal is now read again straight after the lookup, so a stop before the request
  costs nothing. `OAI25` grew the case.
- **`buildHeaders` only protected the exact lowercase names, and that was a real way to send two
  credentials.** Header names are case-insensitive, so a preset's `Authorization` sat beside the
  computed `authorization`, and Node merges those into one header carrying both values. A preset's own
  names are lowercased before the computed ones are set, so there is one name and one value whatever
  case it arrived in, and `OAI19` checks a capitalised `Authorization`, `Content-Type` and `Accept`.
- **`[DONE]` with no finish reason is an ending, not a cut.** The row said either ends the stream and
  the code only accepted a finish reason, which would have retried a complete reply from a compatible
  provider until the run parked. `[DONE]` now settles the reply with `other` as the reason, which is
  what the core already does with a reason it cannot name; a body that ends with neither marker nor
  reason is still the retryable cut it was. `OAI06` grew the case.

## Step 5, PR A (the Lyra half's first three slices), 2026-11-19

- **The provider facts were re-read, and one of Nova's findings no longer holds.**
  OpenRouter's docs (2026-11-19) say usage comes once, in the last chunk before
  `[DONE]`, and that on chat completions the usage chunk carries a content-free
  choice repeating the finish reason rather than an empty `choices` list. More
  usefully, `usage: {include:true}` and `stream_options: {include_usage:true}` are
  both deprecated and have no effect, so the adapter sends neither and the "ask for
  usage in a stream" question closes itself. OpenCode Go's docs now say that every
  text model works through every API, with the console translating, which contradicts
  Nova's "three dialects, model by model" reading (decision 14). So no model is
  refused: a table of dialects would have blocked models that work. What the adapter
  does instead is the thing that is always safe: it sends only the fields every
  chat-completions endpoint takes.
- **There is no quirks table, because there is no quirk to put in it.** The step
  document asked for a small per-model table of accepted `tool_choice` values and
  cache markers. The core has no way to ask for either (the slot's request carries a
  system prompt, messages, tools and a signal), so the adapter never sends
  `tool_choice` and never inserts a cache marker, and a table of accepted values
  would be dead code. Decision 127 records it; the first model that needs something
  written down gets one row and a test.
- **The duplicate-id rule is a rename, not a refusal.** Two calls sharing an id would
  fail `decodeReply` (ids must be unique because the loop pairs a result to its call
  by id), and a refused reply costs a whole turn. So the first call keeps the id it
  was sent, a real id that belongs to exactly one call is reserved for it, and every
  other call gets `call_<n>` from its position. That is stable across a resume, which
  matters more than looking pretty.
- **The size cap ends the stream, and it is not retryable.** Re-reading the same
  oversized stream would cost the same, and a reply past 1 MiB is already a sign of
  something wrong upstream, so the run parks with `provider_error` rather than trying
  again. A stream cut by the network is the opposite case and stays retryable.
- **A finish reason is an ending; `[DONE]` is a marker.** A well-formed stream that
  sends `finish_reason` and never sends `[DONE]` is complete, and a stream that ends
  with neither is a retryable failure with the partial reply discarded. Anything left
  in the buffer at the end of a body is a cut event, and it is an error as well.
- **Stopped is `timeout` with `retryable: false`.** The error codes have no
  `cancelled`, and the loop never believes this error anyway: it checks its own
  signal first and parks the run `stopped`. Using `timeout` keeps the set of codes
  Nova settled (decision 83) closed, and the flag is what keeps it from being retried.
- **The fake server is a `fetch`, and a stall is a request that is never answered.**
  It takes what `fetch` takes instead of a `Request`, because the adapter builds no
  `Request`; the step document's `(Request) => Response` would have meant declaring
  the class for the testkit only. A genuine TCP failure is simulated the way the
  platform produces it: a `fetch` that rejects, and a body that errors while it is
  read. A stall needs no clock: the answer is a promise that only settles when the
  signal aborts, so the adapter's own deadline is what ends it, on the fake clock.
- **`platform.d.ts` grew the model adapters' slice of the web platform.** `fetch`,
  `Response`, `Headers`, `ReadableStream` and `TextDecoder`'s `{stream: true}`, each
  only as far as is used (decision 125). The file's own rule is that a name which is
  missing fails the typecheck, so this is the deliberate act it asks for. The workerd
  program still gets its globals from the Workers types, which is why the testkit's
  own fetch type is spelled out in the testkit rather than named from that file.
- **A 200 that is JSON is either the provider's error or an answer this adapter
  cannot read.** It asks for a stream, so a JSON body is a failure either way; with an
  `error` object the message is the provider's and the retry flag follows its code,
  and without one it is a non-retryable "answered without a stream".
- **No live test has been run, and none can be from here.** There are no keys in this
  environment, so the live suite and real cassette recording are slots 6 and 5 of the
  step and PR B; nothing in this PR claims a real model answered.

## Step R, 2026-11-19

- **npm has no pending publisher, so the first publish is a person's.** The trusted-publisher settings
  live on a package's own page, so a package has to exist before OIDC can be configured for it
  (npm/cli#8544 is the open request to change that). Read from npm's docs and three independent
  write-ups, all saying the same thing. Autumn's decision (121): she publishes once by hand from her
  machine, then adds the trusted publisher for `AutumnsGrove/lyra` and `release.yml`. No token enters
  the repository and decision 99 stands. Two things to remember at the release: a new trusted publisher
  expires unless it completes a publish within **two days**, and the publish step now asks the registry
  first and leaves an existing version alone, so the hand-made publish and the tag push cannot fight.
- **`workflow_dispatch` only lists a workflow that exists on the default branch.** So the dry run this
  step's "Done when" asks for cannot be dispatched from the branch; it is the first thing to do on
  `main` after the merge. Everything else was rehearsed locally: `--prompt-only` against this
  repository, `--check` in both modes, and the fallback paths with the fake agent in the tests.
- **`--check` is in the notes script, not a second one.** It reads the same two things the body does (the
  changelog section, and the tag without its `v`), so a separate script would be the copy that drifts
  (decision 122). A dry run lowers its failures to warnings and returns `0`: a rehearsal for a version
  the changelog has not caught up with yet is the normal case, not an error.
- **Node 26 runs the script with no build step, and the typecheck is a separate program.**
  `scripts/tsconfig.json` extends the root one, adds `types: ["node"]` and
  `allowImportingTsExtensions`, and joins `pnpm typecheck`. `src/` still has `types: []`, and
  `importcheck` still refuses `node:*` there: the script is outside the package on purpose, because it
  is the one thing in this repository that needs a filesystem and a child process. The CI runner gets
  Node 22 from `.nvmrc`, where type stripping is on by default from 22.18.
- **`matrixcheck` now walks `scripts/` too**, and was tried against both violations before it was
  trusted: a row with no test, and a test citing an ID no spec defines. Both failed for the right
  reason, and the second named the file and title.
- **The workflow's shape is tested as text.** A workflow cannot be run from a test, so `RN19` and
  `RN20` parse `.github/workflows/release.yml` with the `yaml` dev dependency already in the tree
  (decision 108) and assert what a green release would hide: the notes key appears once, nothing sets
  an npm token, only the release job may write or mint a token, the publish is guarded by a tag ref and
  `inputs.dry_run != true`, and the notes steps are allowed to fail inside their own deadline.
  `actionlint` passes on the file.
- **The agent command was checked against `pi --help` for 1.5.2**, not copied blind from Nova: every
  flag in the pinned list exists, including `-na` and `-nc`, and `-np` is `--no-prompt-templates`
  rather than a session flag.
- **The pinned toolset kept `bash`** (decision 76). The prompt says the tools are read-only plus a shell
  on a runner that is thrown away, and the key is on that step only.
- **The bootstrap went as decision 121 predicted, and npm's own bookkeeping was the slowest part.** The
  registry's package page was a 404 for about two minutes after `npm publish` succeeded, while
  `npm access list packages` already listed the package: the access list turns over before the
  packument does, so a 404 is not proof that a publish failed. `npm trust github ... --allow-publish`
  wants its own one-time code, because every trusted-publishing change is an account operation now, and
  the new config sits at "Pending validation" until a publish succeeds, with a two-day deadline. The
  `v0.1.0` tag closed it within the hour, and the first version anyone should install is `0.1.0`; the
  `0.0.0` publish exists only so the settings page could exist. `npm access` and `npm trust list` both
  need a code too, which is why the config was checked in the browser rather than by a command.

## Step 4, steps 4 to 7, 2026-11-18

- **Eviction is the test, and a frozen append is the gate.** A run is held either on the fake clock
  (a tool that waits) or by freezing one append with `crashingStorage`; the object is evicted, a fresh
  instance is configured with the same recipe (the way a deploy restores code), and its alarm resumes the
  record. Workerd really drops the instance's memory, so a passing resume really came from SQLite.
- **`runDurableObjectAlarm` only runs an alarm whose time has come.** A future alarm returns `false`. The
  fake clock's epoch is 2023, so the runtime's own 60 s-ahead alarm is already due, which is convenient;
  the one test that needs its own alarm sets it in the past, and the handler test calls `instance.alarm()`
  directly, which decision 101's `import()` limit makes the normal way to reach a handler anyway.
- **A kill before the first `turn_start` leaves no wake to fire.** The runtime arms its alarm as a step
  begins, so a record killed between the `running` status and the first turn has an alarm set already;
  a kill before *that* would not. The kill numbers start at the first assistant append, which is the
  window the step asks about, and the fixture sets a wake by hand for any point that lacked one. If that
  gap is ever worth closing, arming a wake at `run_start` too is a decision of its own.
- **Counting had to sit outside the fault wrapper.** `crashingStorage` returns a promise that never
  settles, so an append frozen "before" never reaches the wrapped adapter; counting inside meant a test
  waiting for append 4 saw 3 and timed out. The fixture counts the attempt, then calls the guard.
- **A record with no header is not rewritten.** A resume over a damaged record fails the run but writes
  nothing, because `appendLine` refuses to write into a record that never started. `CFL13` checks the
  handler returns and the run fails, not that a `failed` status appears.
- **The package ceiling moved to 68 KiB (decision 119), and the example got its own.** The adapter added
  about 3.6 KiB gzipped, which is its real cost, and the example bundle (21.9 KiB) is the number a Worker
  pays, so it is measured directly. The budget script now takes a `dir` entry for a built bundle.
- **The Cloudflare adapter is outside the Node coverage run.** V8 coverage does not exist in workerd
  (decision 101), so its tests cannot contribute to the 85% floor; the floor measures the Node-tested core,
  and the adapter's tests are the workerd suite. The exclusion is named in `vitest.config.ts`.
- **The pinned tooling is three packages, all dev-only** (decision 117): the plugin, `wrangler` and
  `@cloudflare/workers-types`. `pnpm install` brings the workerd binary, so CI needs no extra setup.
- **Review round one found three things, all right.** The changelog's `### Changed` heading had been
  replaced rather than added to, so a breaking API change sat under "Added"; the example's namespace was
  parameterised with a class that does not carry Workers' Durable Object brand; and every request went to
  one object that started a new run each time, which appends a second header into the one table. The
  changelog has its heading back, the example's namespace is unparameterised like the fixture's, the
  example refuses a second run and names sessions by path, and the example is now typechecked in the gate
  (`tsc -p examples/workers-minimal/tsconfig.json`), which is what would have caught the second one.
- **The fuzz timeout went to 60 s.** RCD07 took 37 s on a loaded machine during this step's gate, past the
  30 s set in step 3.

## Step 4, slice 1, 2026-11-18

- **`"types"` cannot name either Cloudflare package.** TypeScript resolves the `types` option under
  the type roots (`node_modules/@types`), and `@cloudflare/workers-types` and
  `@cloudflare/vitest-plugin/types` are not there, so listing them fails with TS2688. The workers
  program includes the two declaration files as roots in `tsconfig.workers.json` instead. That also
  keeps the core's `types: []` and `platform.d.ts` untouched, which is the point of that file.
- **The Workers globals are deliberately not global.** The production adapter will declare the small
  structural surface it uses, so `pnpm build` still compiles with no platform types; only the fixture
  and its tests see `DurableObjectState`, `DurableObjectNamespace` and `cloudflare:test`.
- **`importcheck` now knows the `cloudflare:` scheme**, allowed only for the Cloudflare entry point.
  It was tried against four deliberate violations (a core file naming `cloudflare:workers`, a testkit
  file doing the same, the adapter importing `node:fs`, and the adapter importing the memory entry
  point); all four failed, and the allowed case passed.
- **fast-check runs in workerd.** `CFL00`'s property ran all fifty cases, so property tests can live
  in either suite (decision 117 closes decision 103's item).
- **The wrangler config is a test fixture, not a deploy.** Its `main` is the fixture Worker, and the
  first migration is `new_sqlite_classes` for the fixture class, because Cloudflare cannot add that to
  a class later. Nothing here is ever deployed.

## Step 3, review round one, 2026-11-18

- **The saved input was trusted on resume, and the review was right.** The record outlives a deploy, and
  the pin covers the tool set, not the recipe's input schema, so a parked run resumed under a recipe whose
  input changed could hand `setup` the old shape: a raw `TypeError` out of typed recipe code, or a state
  built from the wrong fields. The recipe's schema is compiled once by the runtime and carried to the run as
  a check; `setup` only runs after the saved input passes it, and a mismatch fails with "the record's task
  input no longer matches the recipe's input schema". A park was the other option the review offered, but a
  person cannot fix it by resuming, so `failed` with that message is the honest ending. `RCP07` is the row.
- **The input check ran before the record's ending was read, and that was the second finding.** A `done`
  record resumed under a schema that had moved got a fresh `failed` status appended, and a wake over a
  parked run wrote `failed`, which is an alarm overruling a person (decision 23). The rebuild is now gated
  on the resume actually continuing: a terminal record's rebuild is best-effort for the caller's state and
  never writes, a recipe-change park never rebuilds, and only a run that is going on fails when its input
  can no longer be rebuilt. `RCP07` grew both cases, and both failed before the fix.
- **`start` could throw where it promised a `Result`.** A hand-written `RunDefinition` with a schema this
  build cannot compile reached `compileSchema` unguarded, and `defineRecipe` is not the only way in because
  `RunDefinition` is public. Compiling is now wrapped and returns `bad_request` with the schema's own
  reason, which also means the schema is compiled once per start or resume rather than twice.

## Step 3, recipes and tools, 2026-11-18

- **The one record that cannot be resumed is a recipe killed between the header and the task message.** The
  recipe's input is saved on the task message (decision 112) because that is the second append, and a
  header-only record has nothing to run `setup` with. Inventing an input would invent the page, so the
  resume fails with "the record has no task input to rebuild the recipe's state" and says so. `RSM07` tests
  that window explicitly rather than skipping it quietly. Saving the input in the header too would close it
  at the cost of keeping a possibly-large input twice; that was not worth it for a one-append window.
- **`finish` is now safe to repeat, and a resume needed it.** `RSM07` killed `finish` between its call and
  its result, and the resume reported the outcome unknown, asked the model for a turn the script did not
  have, and failed. The check is pure, so repeating it cannot duplicate anything; without that mark, a
  killed `finish` costs the run. The testkit's old always-accepting `finish` stub is left alone, because the
  step 2 rows are about the loop rather than the done-check.
- **`defineTool` inferred the state type from `apply` only when `execute` did not lean on it.** Inference of
  `S` from an optional `apply` was not reliable with a `const` schema parameter and an `args`-taking apply,
  so the test recipe annotates `ctx` as `ToolContext<TimelineState>` on the tools whose execute reads state.
  The tool contract itself is unchanged; this is what writing a tool now looks like.
- **A fixture that shares its state poisons the next test, and that is the enforcement row's fault.** TOL09's
  tool mutates `ctx.state` on purpose; its first run pushed "changed in execute" into the shared `first`
  object, and the next test saw it. `firstRun()` now returns a fresh page each time, which is also how a
  recipe is meant to be written.
- **The size ceiling moved to 64 KiB (decision 113) at slice 3, not at the end.** The validator, typed
  tools, the state seam and the record's task input passed 53 KiB before half the step was built, and the
  remaining modules were promised by the step document. The step finished at 62,585 B. The next raise is a
  decision again, not a rounding.
- **Two property runs outgrew the default five-second test timeout, so the timeout was raised, not the
  work cut.** The coverage run pushed RCD06 past it, and the fuzz run pushed RCD07 past it on the same
  machine. RCD06 has an explicit 60 s timeout, and the fuzz config sets 30 s for every target, because a
  high `numRuns` is the point of a fuzz target and five seconds measured the machine rather than the
  property.
- **`Runtime.start` returns a `Result`, which changes a step 2 signature.** RCP05 asks for `bad_request`
  from `start`, and a handle cannot carry one. The step's own row is the reason, and `runtime.test.ts` and
  `waking.test.ts` started through a one-line helper.
- **`ToolOutcome.details` on a refusal is `{ code: "bad_request" }`.** The step document asks for the code
  in details; it is the one detail a refused call carries, and nothing reads it yet.

## Step 2 merged, 2026-11-18

- **A clean review job is not a clean review.** I merged the post-merge docs pull request (#7) because its
  `review / review` job showed `pass`, without reading the two inline comments it had left: both were right,
  both were stale row pointers this step had invalidated, and both should have been fixed before the merge.
  pi-review's job passes when it finishes, and its findings live in the comments, so the thing to check is
  `gh api repos/…/pulls/N/comments`, not the check's colour. They are fixed in the pull request that follows.

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
