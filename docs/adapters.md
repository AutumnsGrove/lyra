---
title: "Lyra adapters: running without Lumen or Warden"
status: planning
category: features
---

# Lyra adapters

Last updated: 2026-11-17. Status: slots confirmed (decision 12). Model details confirmed (decisions 14 and 15). The shell slot is confirmed (decision 17). The Storage slot's cases are written down and the in-memory adapter passes them (step 1a, slice 4).

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
waiting. On Cloudflare the same slot is a Durable Object alarm (step 4).

| ID | Case | Expected |
|---|---|---|
| WAK01 | Happy: a wake follows the steps | A runtime with a Waking slot schedules one wake a step's interval ahead when a step begins, re-arms it for the next step, and cancels it when the run ends |
| WAK02 | Sad: the host died | The wake a dead host left is fired, and a `wake` on the new host resumes the record, answers what was cut off, and finishes the run |
