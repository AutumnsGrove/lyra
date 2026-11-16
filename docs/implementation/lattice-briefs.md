---
title: "Lattice briefs: steps 0, 5 (Lumen half) and 9"
status: planning
category: features
---

# The Lattice side of the first slice

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Three pieces of the first slice live in Lattice (`~/Documents/Projects/Lattice`, `AutumnsGrove/Lattice`), not here (decision 60). They are briefs, not step documents: the code is outside this repository, this session did not read it beyond confirming the paths below still exist, and Lattice has its own instructions that win there.

**Rules for working in Lattice.**
- **Ask Autumn before starting.** Anything outside this repository needs her go-ahead (her global rules). When she gives it, read Lattice's `AGENT.md`, `CODE-STANDARDS.md` and `CLAUDE.md` first and follow them over anything in this folder. Its commit and PR conventions are its own.
- This repository never imports from Lattice, and Lattice reaches Lyra only through a published version of `@autumnsgrove/lyra` (or a local link while developing). Step R's release workflow and a first publish must exist before anything in Lattice depends on Lyra from npm.
- Line numbers in `lumen-changes.md` are from a reading and have drifted. Search by name. The paths below were checked on 2026-11-16 and exist.
- Nothing here has been run. Treat every claim about Lattice's code as a lead to verify.
- The tracking issue is Lattice **#1693** (the Lumen changes, filed as one issue, "to be split when scoping starts"), and **#1605** is the original Lyra issue. Splitting #1693 is a Lattice-side act for Autumn.

## Step 0: the Lumen changes (L1 to L6)

**Goal and done when** (`first-slice.md`): *a two-step tool loop round-trips through Lumen in tests, and a reply cut off by the token limit reports `length`.* L1 and L2 are the only blockers for the first job. L3 to L5 follow alongside, L6 is documentation. Every change is additive, and Reverie's single-turn tool use must keep working throughout.

**Source of truth:** `docs/lumen-changes.md` in this repository (the "Build plan, in order" table, items 1 to 8, and "Found while planning the order"). Do not duplicate it here. Decisions 3, 8, 9, 10, 11, 57, 58.

**Files** (verified to exist): `libs/engine/src/lib/ai/lumen/types.ts`, `.../client.ts`, `.../router.ts`, `.../remote.ts`, `.../config.ts`, `.../providers/openrouter.ts`, `.../pipeline/preprocessor.ts`, `.../quota/limits.ts`, `workers/lumen/src/routes/inference.ts`, `workers/lumen/src/types.ts`, and `docs/specs/lumen-tool-calling-spec.md`. `lumen-models.json` was not located in this pass: find it.

**The contract these must meet** is the Model slot defined in step 1 (`01-core-with-fakes.md`), repeated so the two sides cannot drift: a request carries `system`, `messages` (user, assistant with its own `toolCalls`, and a `tool` role with `toolCallId` and `isError`), `tools`, and an optional `model`; a reply carries `text`, optional `reasoning`, `toolCalls` (`id`, `name`, **raw string** `arguments`), `usage` (tokens always, cost only when known and labelled with a source), a `finishReason` of `stop | length | tool_calls | content_filter | other`, and `model`. An error says whether it is retryable and may carry `retryAfterMs`.

**Order and tests** (each step small, testable alone, test-first as everywhere):
- **L1, tool turns in messages.** `tool` role with `tool_call_id`; assistant messages with their own `tool_calls`; tool messages go through the privacy scrubber like any other message (decision 8). Touches the engine types, the worker's `MessageSchema`, the OpenRouter adapter's `formatMessages`, `RemoteLumenClient`, and `pipeline/preprocessor.ts`. Done when a two-step loop (request, tool call, tool result, final answer) round-trips through the worker route and the remote client in tests, and a scrubber test covers a tool message. Mind the 100-message request cap (item 8): Lyra's step limit must stay under it, or raise it.
- **L2, finish reason.** `finishReason` on the response, normalized to the small set above. Done when a reply cut off by the token limit reports `length`, in a test. The timeline's own comment about replies "cut off mid-object" (`workers/timeline-sync/src/generator.ts`) is the motivating case.
- **L3, the `agent` task,** with quotas zero in every tier, so agent calls must pass `skipQuota`. Four places: `LumenTask`, the worker's `LumenTaskSchema`, `TASK_REGISTRY` in `config.ts`, `LUMEN_QUOTAS` for all five tiers. Done when an agent call without `skipQuota` is refused with a clear message.
- **L4, model flags** in `lumen-models.json`: `supportsTools`, accepted `tool_choice` values, `contextWindow` (step 7 reads it). Done when a model without `supportsTools` fails clearly, and the `agent` task's default model is checked and flagged.
- **L5, usage carries a cost source,** `catalog` for now (decision 15).
- **L6, update `docs/specs/lumen-tool-calling-spec.md`** to describe caller-driven multi-turn use.
- Known and not to be "fixed" here: the router skips its fallback chain when tools are present (`skipFallbacks = !!options.model || !!options.tools`), so model fallback lives in Lyra's recipe (decision 58); and streaming has no tool-call deltas (a later change, decision 56).

**Stop and ask** if a change would break Reverie's single-turn tool use, if `agent` quota semantics need a real rule, or if a model on the default list cannot call tools.

## Step 5, Lumen half: the Lumen adapter, two mock Lumens, and the secrets adapter

**Needs:** step 0's L1 and L2, a published Lyra that includes steps 1 to 3 (the slot types and the testkit), and Autumn's go-ahead. **Where it lives:** Lattice (decision 60), because the adapter needs Lumen's own types and contract.

**Goal and done when** (`first-slice.md`): *the scenario files run through the Lumen adapter into the real Lumen routes over a fake model, and one real call with a tool goes through Lumen.*

**What to build:**
- **The Lumen adapter:** a `ModelSlot` over Lumen's inference route (or the in-process client), mapping Lyra's request to Lumen's and the reply back, including the `agent` task, `skipQuota`, and the per-request provider key (`tenant_api_key`, which the timeline already uses). **The key must never enter Lyra's record or any event** (`lumen-changes.md`, "Notes for the design"). Map Lumen's errors to `retryable` correctly: Lyra's retries are the only protection for agent calls.
- **The secrets adapter** for tenant tokens (the timeline's GitHub token already comes from the tenant's secrets, not Warden, in `workers/timeline-sync/src/generator.ts`).
- **Two mock Lumens, kept honest by contract tests** (decision 67). **Option B, the real Lumen routes in-process over a fake model:** run the actual worker routes and replace only the network call underneath with the scripted fake model speaking OpenRouter's response shape, so validation, scrubbing, routing (including the skip-fallback rule), parsing, finish reason and cost all run for real. Lumen's inference call is plain JSON, not a stream, so the fake must answer in that form. Pass `tenant_api_key` and `skipQuota` so neither Warden nor quota is involved. `libs/engine/src/lib/ai/lumen/lumen-integration.test.ts` already runs the real client pipeline and fakes only the network call, so it is the pattern to copy. **Option A, a standalone fake Lumen:** a small server imitating `POST /inference` and its success and error envelopes, fast and independent. **One shared contract suite runs against both, and any difference fails the build.**
- The Lyra testkit (`@autumnsgrove/lyra/testkit`) supplies the scripted model and scenario runner. The scenario files run a third time, through the adapter into real Lumen routes into the fake model.
- Each of L1 to L5 gets tests through this harness.

**Open questions that only Lattice can answer** (decision 103): how Lumen gets its provider key in the local dev stack (`./scripts/dev-stack.sh` runs the real workers on one Miniflare; the per-request key is one option), and whether the default model supports tools (L4). Do not guess: ask.

## Step 9: the timeline task

**Needs:** Lyra steps 1 to 8 merged and published, step 0, and the Lumen adapter. This is the checkpoint: version one complete and the timeline running through it (decision 59). **Where it lives:** Lattice, `workers/timeline-sync` and the Arbor routes under `apps/aspen/src/routes/api/curios/timeline/` (`generate`, `backfill`, with their own `builder.ts` and `github-fetcher.ts`).

**Source of truth:** `docs/timeline-first-job.md` (the tool table, handles, limits, "Checked (2026-11-15)", the two places that generate a day). Decisions 4, 6, 8, 54, 59, 61, 92.

**Goal and done when** (`first-slice.md`): *a real day runs on Workers with a record, from both entry points. Autumn compares the output with the current one for a few days.* That comparison is hers: produce the outputs and make them easy to compare, but do not judge them for her.

**What to build:**
- **One shared function** that runs the Lyra task, called by both the nightly worker and the Arbor generate and backfill routes, which switch over **together** (decision 61). The GitHub fetching for pull requests and issues is written **once** (it is duplicated today, and the app's copy appears to mirror `github.ts` but was not compared line by line). Whether GitHub access goes through Warden is unchecked: ask.
- **The timeline recipe** on Lyra's recipe machinery (step 3): instructions, input (the day), `setup` that hands the whole day over up front with handles `c1`, `pr12`, `i34` (decision 6, 8), the tools from the table (`get_diff`, `get_issue_thread`, `search_past_days`, `start_project`, `add_line`, `add_vine`, `mark_continuation`, `finish`), a coverage check on `finish`, and a step limit of 40 (decision 92), configurable. Tools own repo names and links, so the model never types either.
- `search_past_days` must **not** trust the stored `detected_focus` or `focus_streak` (the keyword guesses that are wrong today) and cannot rely on stored commit, PR or issue lists from earlier days (the table keeps prose and repo names). If each day's Lyra record is kept, it holds the exact data the model was given and is the better source.
- **Vines:** until issue #1687 lands, the task attaches vines to headings, as the page does today. `add_vine` can take a line id as soon as the page supports one. #1687 is not Lyra's work.
- The recipe's `finish` coverage check is what makes a day of only issue work stop looking empty ("these four issues are not covered yet").
- Run it through Lyra's record: a day's record is the audit trail, and records belong to the tenant (decision 51).

**Stop and ask** before touching the nightly worker's production behavior, before the cutover of either entry point, and before spending a Wanderer's own provider key on anything beyond the comparison runs. The two entry points switching together means a cutover Autumn should see coming.
