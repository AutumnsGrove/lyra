---
title: "Lyra: the core loop"
status: building
category: features
---

# The loop, and the vocabulary around it

Last updated: 2026-11-17. The spec for the core: the types every slot is written against, time and
identity, decoding what a model sends back, and the loop that runs a job. The slices that build it are
in [`implementation/01-core-with-fakes.md`](implementation/01-core-with-fakes.md), and this document is
where their rows live. It adds no decisions; when it and `decisions.md` disagree, `decisions.md` wins.

The loop itself arrives with step 1b. This document grows a section and a row table per slice, so every
row a test cites has a home from the first commit (`scripts/matrixcheck.mjs` fails a test that cites an
ID no spec defines).

## Failure is a value

A failure never crosses a module boundary as an exception. It is a `Result`: `ok: true` with a value, or
`ok: false` with an error carrying one of the nine stable codes (decision 83). Messages are written for
a person and never contain a secret.

## Time and identity are injected

The core never reads the real clock and never draws its own randomness. It asks a `Clock` for the time
and an `Ids` source for an identifier, both of which arrive in a run's dependencies. The one file that
touches the real ones is `core/system-clock.ts`, and `scripts/importcheck.mjs` fails any other
production file under `src/` that calls `Date.now`, `new Date(`, `setTimeout`, `setInterval`,
`Math.random`, or `console.`. Console is on that list because a log is the easiest way for a secret to
leak.

That rule is checked by running it against a deliberate violation rather than by a row, so it has none.

| ID | Case | Expected |
|---|---|---|
| CLK01 | Happy: the system clock | `systemClock().now()` is epoch milliseconds: an integer, and above the millisecond value of 2023-11-14, so a clock reporting seconds fails |
| CLK02 | Sad: a sleep is aborted | `sleep` rejects as soon as its signal aborts and leaves no pending timer; an unaborted sleep resolves and leaves none either |
| CLK03 | Happy: ids are unguessable | `next(prefix)` begins with the prefix, and 1,000 ids are distinct, each carrying 128 random bits (32 hex characters) |

There is no bad row here yet: no untrusted input reaches either, and the prefix comes from Lyra's own
code. Whether `Ids` should reject an empty prefix is settled in a later step, when something outside the
core can suggest one.
