---
title: "Lyra implementation notes"
status: planning
category: features
---

# Implementation notes

The handoff file (see [`README.md`](README.md)). Judgment calls, surprises, and loose ends from building, newest first. One short entry each, headed with the step and the date, saying what was chosen and why. Autumn reads this before she reads a diff.

Nothing has been built yet.

## Step 1a, 2026-11-17

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
