---
title: "Lyra implementation notes"
status: planning
category: features
---

# Implementation notes

The handoff file (see [`README.md`](README.md)). Judgment calls, surprises, and loose ends from building, newest first. One short entry each, headed with the step and the date, saying what was chosen and why. Autumn reads this before she reads a diff.

Nothing has been built yet.

## Step 1a, 2026-11-17

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
