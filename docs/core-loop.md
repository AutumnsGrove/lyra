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

## Decoding what a model sends back

An adapter hands the core a value it built from a wire response, and the core
decodes it before anything else touches it. This is the boundary the record,
the fake model and step 5's adapters all feed, so it is validated here once:
hand-written guards, no schema library, tolerant about what a provider may
leave out and strict about what it may get wrong.

Three rules: an unknown extra field is ignored, because providers add them
without warning; a missing optional field takes a documented default rather
than failing a run over it; and a field of the wrong type is `bad_request` with
a message naming the field, because that is a bug in an adapter and the caller
needs to see it. Tool arguments stay raw text, since a model can send invalid
JSON and the loop hands that back as an error result (decision 21).

| ID | Case | Expected |
|---|---|---|
| MOD01 | Happy: a whole reply | Text, two tool calls, usage with a cost, a finish reason and a model name all decode into the same values |
| MOD02 | Sad: a reply cut off by the token limit | `finishReason: "length"` decodes with its tool calls intact and the reason kept, because the loop decides what to do about it |
| MOD03 | Bad: the optional parts are missing or unknown | A missing or unknown finish reason becomes `other`; missing usage becomes zero tokens and no cost; a missing text or model becomes the empty string; an unknown extra field is ignored |
| MOD04 | Bad: a tool call is malformed | A missing or empty id, an empty name, a duplicate id, `arguments` that is not a string, a call that is not an object, or `toolCalls` that is not a list: each is `bad_request` naming the problem |
| MOD05 | Bad: a token count is not a count | A negative, fractional, infinite or non-numeric input or output count is rejected |
| MOD06 | Bad: the value is not an object | `null`, a list, a string, a number and a boolean are each `bad_request` |
| MOD07 | Bad: text or reasoning is the wrong type | Present but not a string is rejected; absent is not |
| MOD08 | Bad: the model name is the wrong type | Present but not a string is rejected; absent becomes the empty string |
| MOD09 | Bad: a cost is malformed | A negative or non-numeric amount, a currency other than USD, or a source outside the three known ones is rejected |
| MOD10 | Bad: any input at all | Any JSON value decodes or is `bad_request`, never throws, and a reply that is accepted always satisfies the type (a fuzz target) |
