---
title: "Lyra adapters: running without Lumen or Warden"
status: planning
category: features
---

# Lyra adapters

Last updated: 2026-11-18. Status: slots confirmed (decision 12). Model details confirmed (decisions 14 and 15). The shell slot is confirmed (decision 17). The Storage slot's cases are written down and the in-memory adapter passes them (step 1a, slice 4). The Cloudflare adapter (step 4) fills Storage, Waking and Secrets over a Durable Object, and its own suite runs in workerd.

## The goal

Lyra should run in any TypeScript project, including ones that have no Lumen and no Warden, and including ones that run on Cloudflare. Grove's pieces become adapters. Lyra's core does not know they exist.

This is more work than hard-wiring Grove in. It also makes Lyra easier to test and keeps it from being shaped around one platform.

## The idea: four slots

Lyra's core defines four small slots. Each is a short interface, a few functions. Each has a simple version for general use and a Grove version.

| Slot | What Lyra needs from it | Grove's version | Elsewhere |
|---|---|---|---|
| **Model** | Send a conversation and a list of tools. Get back text, tool requests, token usage and cost, and the reason the model stopped. | Lumen | OpenRouter (primary), OpenCode Go, or any OpenAI-style endpoint |
| **Storage** | Save and load a run's record and its progress. Append-only. | Durable Object storage | Memory (for tests), SQLite or a file (Node) |
| **Secrets** | Let a tool ask for a key or token by name. | Warden, or the tenant's encrypted secrets | Environment variables |
| **Waking** | Wake a run later, after a wait or an interruption. | A Durable Object alarm | A timer (Node), or nothing for a simple script |
| **Shell** (optional) | Run a command, return its output. The tool is `bash` on every host. Long commands move to the background (decision 38). | None at first | A real shell (Node). A virtual shell such as just-bash could fill it on Workers later (untested). |

The list is expected to grow as more places Lyra runs are discussed.

## Where Lyra runs

Cloudflare Workers is the main development target, because it is the hardest environment: no filesystem, no subprocesses, and limits on time and memory. The same core also runs on Node. Developing against the stricter environment keeps the core portable.

One example of the second case is a GitHub Action runner doing a review job with OpenCode Go, which Autumn already pays for. A runner has a real filesystem and a real shell, so file tools and a bash tool make sense there and not on Workers (decision 16). Tools belong to tasks (decision 5), so a task can use host-specific tools without the core knowing. Nova already has a pull request review action (`nova action review`), so the runner case is mainly a useful test of the Node side.

## Model connections (decisions 14 and 15)

Autumn's two providers are OpenRouter (primary) and OpenCode Go. Nova has already worked through both, and three lessons carry over. The code does not (Nova is Go), only the shape.

- **OpenCode Go is not one dialect.** Nova needed three streaming dialects for it (chat completions, OpenAI Responses, Anthropic Messages), because different models on the gateway speak different ones. Decided: Lyra's first model adapter speaks chat completions only. That serves OpenRouter and OpenCode Go with different settings (address, key, model ids), and only models that speak chat completions are used at first.
- **Cost is not always dollars per call.** OpenCode Go draws on a shared subscription allowance, has a monthly limit per model, and some models cost more at certain hours. Nova's usage record carries tokens, a cost, and the cost's source (`provider`, `allowance`, or `catalog`). Decided: the same shape. Tokens are always reported. Cost is reported only when known, with its source. Limits on tokens, steps, and time always work, and a cost limit works only when real cost is reported.
- **Models differ in small ways the adapter must know.** Which `tool_choice` values a model accepts varies (some accept only `auto`). Whether a repeated prompt prefix is cached automatically or needs a marker varies. The adapter holds this per model. The core never sends options a model might reject.

## Where Warden sits

Warden is not part of Lyra's loop. The loop never touches a key except the model's, and the Model adapter handles that. Keys matter to tools: a GitHub reader needs a GitHub token.

So tools ask the Secrets slot for what they need by name. A tool written once then works in Grove and in another project. In Grove the answer may come from Warden or from the tenant's encrypted secrets (the timeline's GitHub token already comes from the tenant's secrets, not Warden, in `workers/timeline-sync/src/generator.ts`). Elsewhere it comes from an environment variable. The tool does not need to know which.

## What stays in the adapters

A fallback model is part of a task's recipe, not of the Model slot (decision 58), so the same recipe works against any adapter. Lumen's concepts live in the Lumen adapter and nowhere else: task types (including the new `agent` task), the privacy scrubber, quota, Songbird, and the tenant's provider key. The Cloudflare adapter holds the bindings. The Warden client lives in Grove's tools.

## The rules that keep it honest

- The core imports nothing from the adapters, and nothing specific to Cloudflare or Node. It uses web-standard APIs only.
- A check in the repository's CI enforces that. Nova does the same with its core and UI ("the core never imports the UI; a check enforces it").
- The model slot's request and response stay generic: messages, tools, and a result with text, tool requests, usage, and a finish reason. No `task`, no `tier`, no tenant.

## What this buys

- **Other projects.** Lyra works in the TypeScript projects that have no Lumen or Warden.
- **Tests with no network.** A fake model plus in-memory storage lets the whole loop be tested without calling anything. Pi and Nova both test this way.
- **A clean answer to "where does Lyra run?"** The core runs anywhere. Cloudflare is the first adapter and Node comes second, which matches the original issue.

## What it costs

Four small interfaces plus an optional shell, and one real risk: Lumen-shaped ideas leaking into the core (a `task` field, a quota concept). The rules above are the guard. The two blocking Lumen changes in `lumen-changes.md` (tool turns in the conversation, and a finish reason) are exactly what the model slot needs from any provider, so they are not Lumen-specific.

## Left out on purpose

- **The wire protocol and transport** (HTTP, JSONL frames) is a thin layer on top of Lyra. Discussed later.
- **How a person is told that an approval is waiting.** Settled in decision 36: a simple indicator in the viewer reads the list of pending requests, so no notify slot is needed for now.

## Settled

- **Packaging inside the repository.** One package with subpath exports (decision 69): the core, `memory`, `cloudflare`, `openai`, and `testkit`, each with its own allowed imports.
- **The in-memory adapter is built** (step 1a, slice 4), and the storage contract it passes is what the
  Cloudflare adapter will run in step 4, so the two cannot drift in ordering, `seq`, or what an
  over-long line does.
- **Whether the Cloudflare adapter builds on Cloudflare's agent tooling or on plain Durable Objects.** Plain Durable Objects (decision 72), behind the slots, using SQLite storage, an alarm, and hibernation. Cloudflare's agent tooling stays available to a consumer, and a separate adapter for it can come later. The tooling was reread on 2026-11-16 and the decision holds (decision 101).

## Spec rows: storage

The Storage slot deals in JSON lines, not objects, so the core owns encoding
and decoding and an adapter only saves and reads bytes in order (decision 12,
and `implementation/01-core-with-fakes.md`, "Storage deals in lines"). Every
adapter runs the same cases: the contract lives in
`packages/lyra/src/testing/storage.contract.testing.ts`, and the in-memory adapter is
the first to run it.

`seq` is the line's zero-based position, in the order the lines were saved. It
is the position protocol events will carry in step 6 (decision 86), so it is
stable and never reused. The line limit is the adapter's own, always below the
host's hard limit and above the record's 1 MiB entry cap (decision 90); a line
over it is refused and nothing is stored, so a save never half-happens.

| ID | Case | Expected |
|---|---|---|
| STO01 | Happy: append and read | Appends return `seq` counting up from zero, and `read` returns every line in the order it was saved |
| STO02 | Sad: nothing saved yet | `read` on empty storage returns an empty list, not an error |
| STO03 | Bad: awkward and oversized lines | A line holding newlines, U+2028 and a very long string round-trips exactly; a line over the adapter's limit is refused and stores nothing |
| STO04 | Bad: appends at the same time | Appends issued together get distinct, increasing `seq` values in the order they were issued |
| STO05 | Happy: counter ids | The in-memory id source returns the prefix and an increasing number per prefix, so the same script writes the same record twice |

### Waking (step 2)

A host wakes a run whose process died, and the runtime is what decides when: as a
step begins it sets one wake a configurable interval ahead (60 s by default),
re-arms it on the next step, and cancels it when the run ends, so a finished or
parked run is never woken. The in-memory adapter records what would have been
scheduled and fires it on demand, which is how an interruption is exercised without
waiting. On Cloudflare the same slot is a Durable Object alarm (step 4): there is one alarm per object and one active run per session, so one row says which run to wake and when, and `setAlarm` replaces any earlier one.

| ID | Case | Expected |
|---|---|---|
| WAK01 | Happy: a wake follows the steps | A runtime with a Waking slot schedules one wake a step's interval ahead when a step begins, re-arms it for the next step, and cancels it when the run ends |
| WAK02 | Sad: the host died | The wake a dead host left is fired, and a `wake` on the new host resumes the record, answers what was cut off, and finishes the run |

## Spec rows: the Cloudflare adapter (step 4)

The adapter fills three slots on Cloudflare: `StorageSlot` over a Durable Object's
SQLite, `WakingSlot` over its alarm, and `SecretsSlot` over Worker bindings. Its
production code imports the core, and names the runtime's modules (`cloudflare:workers`)
only if it must; the worker test program gets Workers globals from a separate
`tsconfig.workers.json`, so nothing here adds a global to the core's own program.

Each case runs in workerd through Miniflare, so the storage is a real Durable
Object's SQLite, the alarm is a real alarm, and eviction drops the instance's
memory as a deploy would.

| ID | Case | Expected |
|---|---|---|
| CFL00 | Happy: the workerd suite runs | A Durable Object in the test Worker answers a request over its real storage, and a fast-check property runs inside workerd, which settles decision 103's open item |
| CFL01 | Happy: a full 1 MiB entry | A line of exactly 1 MiB saves to real Durable Object SQLite and reads back byte for byte, so decision 102's documented row limit is a fact rather than a page |
| CFL02 | Bad: the adapter's own limit | A line at the limit saves and one byte over is refused with `bad_request`, nothing is stored, and the oversized text is not in the message |
| CFL03 | Sad: a storage that fails | The adapter returns an error result rather than throwing, and a run whose append fails ends `failed` once, with nothing half-written |
| CFL04 | Bad: appends issued together | Appends issued together get distinct, increasing `seq` values, because each one is a synchronous SQLite transaction |
| CFL05 | Happy: eviction | What was written survives `evictDurableObject`, and the next append continues the sequence rather than starting again |
| CFL06 | Bad: a damaged row | A malformed line inserted straight into the table is read as it is and loads through the record loader tolerantly |
| CFL07 | Happy: a scheduled wake | `schedule` then `runDurableObjectAlarm` runs the handler once |
| CFL08 | Happy: a second schedule | It replaces the first: the row names the new time, and the object holds one alarm |
| CFL09 | Happy: a cancel | After `cancel`, no alarm runs |
| CFL10 | Sad: after the run finished | The runtime cancelled the wake when the run ended, so firing the alarm has nothing to do |
| CFL11 | Bad: an alarm delivered twice | Delivered twice for the same dead run, it resumes the run once: the second delivery joins, and the record holds one `resumed` |
| CFL12 | Bad: an alarm while the run is live | It joins the run the object is already driving rather than starting a second loop, and the record holds no `resumed` |
| CFL13 | Bad: an unreadable record | The handler returns without throwing when the record cannot be read, and the run it woke fails instead of the alarm being retried forever |
| CFL14 | Happy: held, evicted and woken | A run held mid-tool, whose object is evicted, resumes through the alarm and ends `done` |
| CFL15 | Happy: killed at every append | Killed at every append from the first reply on, before and after it, each run resumes and ends `done` |
| CFL16 | Sad: an unsafe tool in flight | A call the kill left unanswered is never run twice, and the record tells the model its outcome is unknown |
| CFL17 | Happy: the resumed record | For each kill point, the resumed record carries the same calls and results as the uninterrupted one, once statuses and unknown outcomes are set aside |
| CFL18 | Happy: the half-built page | For each kill point, the resumed timeline page and handle table equal the uninterrupted run's |
| CFL19 | Happy: a binding | A Worker binding is read by name |
| CFL20 | Bad: a missing binding | It is `undefined`, and a tool that needs it returns an error naming the secret but never its value; a scan of the record finds no value, after the positive case proves one was held |
| CFL21 | Bad: names that are not secrets | A non-string binding, `constructor`, `__proto__` and `toString` are each `undefined` |

## Spec rows: the OpenAI-style model adapter (step 5)

One adapter speaks chat completions for both of Autumn's providers (decision 14):
OpenRouter, and OpenCode Go with different settings. It takes a `baseUrl`, a model,
a `SecretsSlot` and a key name, and it reads the key from the slot, never from its
own configuration, so a key cannot sit in an object that gets logged or recorded.
`fetch` is injectable, which is how the fake server and cassette replay plug in.

The provider facts it rests on were verified against the providers' own docs on
2026-11-19 and are written in `implementation/notes.md` under "Step 5". Two of them
shape the parser: OpenRouter returns usage exactly once, in the last chunk before
`[DONE]` (its usage chunk carries a content-free choice rather than an empty
`choices` list), and `usage` and `stream_options` parameters on chat completions are
deprecated and have no effect, so the adapter sends neither.

### The stream

An OpenAI-style reply is a stream of server-sent events, each carrying one JSON
chunk. The parser is pure, has no clock and no network, and is the most hostile
input surface in the repository, so it is a fuzz target. What it assembles goes
through `decodeReply` before it leaves the adapter, so the loop only ever receives
a validated reply.

| ID | Case | Expected |
|---|---|---|
| OAI01 | Happy: a plain text stream | Text deltas assemble into one reply with its model, its token usage and `stop`, and the reply the slot returns has been decoded |
| OAI02 | Happy: a call split across chunks | A name first, arguments in fragments and the id late assemble into one call whose argument text is exactly what arrived |
| OAI03 | Happy: two calls interleaved | Calls are kept apart by their index and reported in index order, however they interleave |
| OAI04 | Happy: usage | Usage in the last chunk, in a chunk of its own, or missing all give tokens, zero when the provider said nothing, and a cost labelled `provider` only when one was given |
| OAI05 | Bad: empty choices and null content | A chunk with no choices, a `null` content and a content-free usage chunk add nothing and change nothing |
| OAI06 | Sad: a stream that stopped early | A stream cut mid-event, or one that ends with neither a finish reason nor `[DONE]`, is a retryable `provider_error` and the partial reply is discarded; either a finish reason or `[DONE]` ends the stream |
| OAI07 | Bad: a call with no id | A call whose id never arrived gets the stable synthetic id `call_<n>` from its position |
| OAI08 | Bad: duplicate ids | Two calls sharing one id are both kept, the later ones renamed, so the loop can answer each of them |
| OAI09 | Bad: unknown fields | Fields the adapter does not know are ignored wherever they appear, and a chunk that is only unknown fields changes nothing |
| OAI10 | Bad: line endings, comments and a multi-line event | `\r\n` and `\r` split events like `\n`, comment lines are ignored, split `data:` lines join with a newline, and `data: [DONE]` ends the stream |
| OAI11 | Bad: an oversized stream | A stream past the size cap fails as `provider_error` and stops being assembled |
| OAI12 | Sad: a broken chunk | A `data:` payload that is not JSON, or JSON that is not an object, is a retryable `provider_error` naming the problem |
| OAI13 | Bad: hostile bytes | Any bytes at all give a reply or an error: never a throw, never a loop, never an unbounded reply |

### Requests

The request the slot takes is generic (a system prompt, messages, tools, a signal),
and the wire wants the same things spelled its own way. Two rules shape the
mapping. Nothing is sent that a model might reject: there is no `tool_choice`, no
`stream_options`, no usage switch and no provider field, because the core has no
way to ask for one and both endpoints can answer without them (the model facts are
in `implementation/notes.md`, "Step 5"). And the key exists in exactly one place,
the `Authorization` header, built from what the Secrets slot gave and never from
anything that could be logged or recorded.

| ID | Case | Expected |
|---|---|---|
| OAI14 | Happy: every message kind | A user turn, an assistant turn with its calls and a tool result each map to the wire's own shape, and the system prompt is sent only when there is one |
| OAI15 | Happy: a tool turn round trips | The `tool_call_id` on a result is the id of the assistant turn's call, so the provider pairs them, and a result's error flag is not invented as a wire field |
| OAI16 | Bad: options a model might reject | The body holds only the model, the messages, the stream switch and the tools, so no option a model could refuse is ever sent |
| OAI17 | Happy: tools and the model | Each tool maps to a function with its name, description and parameter schema (an empty one kept), and a recipe's fallback model overrides the configured one |
| OAI18 | Bad: nothing to send | An empty system, no messages and no tools still build a body the endpoint accepts, rather than a request with a hole in it |
| OAI19 | Bad: the key lives in one header | The `Authorization` header carries the key, a session header appears only when one was given, a preset's own headers are sent, and none of them can replace the key; the body holds no key at all |

### The slot and its errors

A failure is a `ModelError` with the right `retryable` flag, because step 2's
retries trust it: a retryable failure is tried again and then parks the run, and
a permanent one fails it at once. Nothing here throws across the boundary, and no
message ever contains the key or an `Authorization` header. A call that is stopped
is not a failure: the loop reads the signal and parks the run `stopped`.

| ID | Case | Expected |
|---|---|---|
| OAI20 | Sad: the HTTP statuses | 400, 401, 403, 404 and any other permanent status are not retryable and name the status; 408, 429, 500, 502, 503 and 504 are retryable |
| OAI21 | Sad: `Retry-After` | Seconds and an HTTP date both become a wait, a date in the past and a missing header give none, and an absurd value is capped |
| OAI22 | Sad: an answer that is an error | A 200 whose body is an error object, a non-JSON error body and an error chunk mid-stream are errors whose message is the provider's, truncated, and never echoes a request header or the key |
| OAI23 | Sad: the network | A `fetch` that rejects, and a body that fails while it is being read, are retryable `provider_error`s |
| OAI24 | Sad: a stall | A call that never answers is abandoned at the deadline as a retryable `timeout`, on the fake clock |
| OAI25 | Bad: a stop | Stopped before the request, during connect, mid-stream and after the last chunk, the call is an error the loop reads as a stop, and the stream is not left open |
| OAI26 | Happy: the whole slot | A scripted stream through the fake server comes back as that reply, with its usage and cost, and what the server received is the mapped request with the key in one header |
| OAI27 | Happy: a retry that succeeds | A 429 followed by a good stream completes the run, and the record keeps one `retry` |
| OAI28 | Sad: retries exhausted | Four 500s park the run `model_unavailable` |
| OAI29 | Bad: cut off on the token limit | A stream that ends on `length` while holding a tool call never runs that tool |
