---
title: "The playground slice"
status: planning
category: features
---

# The playground: a SvelteKit chat Worker that runs Lyra for real

Last updated: 2026-11-24. Read [`README.md`](README.md) first. This is issue #60, planned rather than
built: nothing here is in the tree yet. Autumn named it next on 2026-11-24, with **#59 before it** and
**Fireside (#63) after it**, and answered the five shape questions in this document's "Settled here".

Read: #60 and its two comments, `docs/overview.md`, `docs/protocol.md` ("Commands", "Events", the HTTP and
access rows), `docs/adapters.md` (the Cloudflare and OpenAI adapters), `packages/lyra/src/protocol/session.ts`,
`packages/lyra/src/adapters/cloudflare/session.ts`, `examples/workers-minimal/`, and `scripts/lyra.mjs`
(the dev client, which is the proof that the protocol is enough to build a client on).

## Goal and done when

**One Worker at a URL, a page a person can use on a phone, behind a token, that shows Lyra working: tool
calls, thinking traces, a question card, a record — against a real model, with a real Durable Object, on a
real deployment.**

Concretely:

- the page is a **SvelteKit app built as a static SPA**, served as Workers assets by the **same Worker**
  that serves `/v1/*`, so a browser talks to one origin and there is no CORS and no second deployment;
- a **token box** takes the bearer token, keeps it in `localStorage`, and every request carries it; a
  person who finds the URL without the token gets a login screen and nothing else;
- a **sidebar of conversations**, each one a session (decision 44), kept across reloads and across an
  object eviction, and **a conversation rather than one run**: two runs in one session with a question
  answered between them is an acceptance row, not only a smoke check;
- a run shows **the transcript, every tool call with its arguments, result, duration and error, and the
  model's thinking trace**, and the trace survives a reload because it is on the record;
- **steer, follow-up, stop**, a **question/approval card** answered in the page, a **status line** (state,
  turns, usage, which limit if any), and a **record panel**;
- a **model picker** over a short allow-list, with `deepseek/deepseek-v4.1-flash-1017` in it, because it is
  the model Autumn wants to try first;
- a **hard per-tenant, per-UTC-day cost cap** from a binding: over the cap, a new run is refused, a
  running one finishes;
- a push to `main` **deploys it** and a smoke job drives the deployment with a **scripted model** so the
  assertions are exact, not "it did something".

## What already exists, so this slice does not rebuild it

| Piece | Where | State |
| --- | --- | --- |
| Both transports | `protocol/http.ts`, `adapters/cloudflare/session.ts` | `POST /v1/commands`, `GET /v1/events` (SSE with `last-event-id`), `GET /v1/ws` with hibernation, `POST /v1/ui_response`. All tested, four levels |
| The status panel's data | `session.ts`, `get_state` | `state`, `parked{reason,detail}`, `turns`, `usage`, `queue{steers,followUps}`, `pending` |
| The record panel | `get_messages` | paged entries |
| Approval and question cards | `list_pending`, `ui_response`, the alarm | a timeout is denied by the alarm, a second answer is `conflict` |
| Thinking traces | `core/model.ts`, `adapters/openai/sse.ts`, `record/entries.ts` | the adapter already collects `reasoning`/`reasoning_content`, and `run.ts` already saves it on the assistant entry. **Only the live event lacks it** (below) |
| The front door | `createSessionWorker` | authenticates, routes `/v1/*` to the object, 404s everything else, which leaves the asset route to this Worker |
| A protocol client | `scripts/lyra.mjs` | `start`, `tail`, `steer`, `follow-up`, `abort`, `resume`, `messages`, HTTP and WS |
| Parallel tool calls | decision 154, **pull request #69** | not on `main` when this plan was written, so it is a prerequisite rather than a fact about the tree; the fan-out tools below want it, and the page shows several calls in flight at once |

## Settled here (Autumn, 2026-11-24)

Each of these becomes a numbered entry in `docs/decisions.md` in the slice that lands it.

Autumn gave these five answers in a session on 2026-11-24 rather than on #60's thread, and this section is
their record; the slices cite it as the authority, so if they belong on the issue, paste this list there.

- **SvelteKit, as a static SPA served by the same Worker.** `adapter-static` with a SPA fallback, built into
  the Worker's assets; the Durable Object class stays in the hand-written Worker entry. Server-side rendering
  would force the DO class out of a custom Worker entry and buy nothing for a chat page.
- **`packages/playground`**, an unpublished workspace package. Lattice imports the factory for the Lumen
  Worker (`AutumnsGrove/Lattice#1815`), and the published `@autumnsgrove/lyra` has a size budget that a
  playground's tools do not belong inside.
- **A token box, `localStorage`, and it lasts.** The token is entered once, stored, and sent with every
  request (`Authorization: Bearer`); a refusal on the command or event surface clears it and shows the box
  again. That refusal is **403 `permission_denied`**, which is what `statusForCode` answers for a missing or
  unknown token (HTP02, ACC02) — the HTTP surface never returns 401. The socket upgrade is the one 401
  (WSK04), so the page resets on either. The Worker's token comes
  from a secret binding, and it is what stops a passer-by using the deployment.
- **One model picker over an allow-list** in a binding (`PLAYGROUND_MODELS`), with
  `deepseek/deepseek-v4.1-flash-1017` first. A free-text model id would turn a typo into a failed run and a
  surprise bill.
- **A sidebar of conversations**, each a session, listed from an index the playground owns. The index
  holds each conversation's id, its label, when it was last used, and **the recipe it runs**, so the page
  can start a conversation on `tool-table` and later on `fireside` without a second deployment (#60's
  Decided comment). The pick is at "new conversation", and a conversation keeps its recipe for its life,
  because the recipe is what the run is pinned to (decision 91). Lyra's
  `list_sessions` answers `unsupported` on purpose ("listing every session needs an index of its own"), so
  the index is a playground object, not a change to Lyra's protocol. If it earns its place later it moves
  into Lyra as `list_sessions`.
- **Traces are saved, not only streamed.** The record already has them; the page reads them from the record,
  so a reload, a replay and a second client all show the same reasoning. This needs one small addition to
  the live path (below) rather than a new store.
- **The day cap is hard, per tenant, per UTC day.** A small budget object counts the cost each reply
  reports; a new run over the cap is refused with `limit`/`cost`, and a run already going finishes. The
  number is a binding (`PLAYGROUND_DAY_CAP_USD`), and the page shows spend against it. **A reply that
  reports no cost (LIM05) marks the day unpriced**, and from then on a new run is refused until the day
  rolls over, because a "hard" cap that silently undercounted would be worse than no cap. A token count is
  not used as a fallback: it is not money, so it would put a precise-looking number on a guess. The budget
  object learns it from the run's own record — the `limit_unenforceable` note LIM05 already writes, or a
  `usage` event with no `cost` — so nothing new is added to the core for it. That rule is a host policy
  on top of a core row, so it gets its own decision when the slice is built.
- **The smoke job runs a scripted model on the deployment, behind a boundary that is named.** A `start`
  carrying `x-lyra-script` is accepted only when `PLAYGROUND_SCRIPT_TOKEN` is set **and** the header matches
  it exactly (a constant-time compare); otherwise the request is refused `permission_denied` (**403**,
  which is what the command surface answers, HTP02) and nothing runs. **The tenant is never taken from the header**: it is the one the bearer token resolved to
  through the existing door, and scripts are allowed only for the smoke token's tenant
  (`PLAYGROUND_SMOKE_TENANT`), so a script cannot reach a person's session. The script is held on the
  session object for the run it starts and dropped when the object is rebuilt. A script that is not JSON, is
  not a list of turns, or is larger than the cap is refused `bad_request` before the command runs. With the
  secret unset, a request carrying the header is refused rather than quietly falling back to the real model,
  so a smoke job against a deployment that cannot be scripted fails loudly instead of testing the wrong
  thing.

## Prerequisites

0. **Decision 154 and `Tool.parallel`** — pull request #69, merged on 2026-11-24. The fan-out tools in
   Slice 5 and the page's several-calls-in-flight view both assume it.
1. **#59: a host runs its own recipe through a scenario file.** `runScenario` only knows `timeline-test`, so
   the playground's recipes cannot be asserted by scenario files at all — the acceptance table below would
   have to be re-implemented in TypeScript, which is the copy that drifts. One `ScenarioRunOptions.recipes`
   map, as #59 proposes. **This is the first thing to build.**
2. **The live trace.** `run.ts` saves `reasoning` on the assistant entry, but `message_end` carries only
   `text` and `toolCalls`, so a live client can only show a trace by re-reading the record. Add
   `reasoning?` to the `message_end` event and to the protocol's projection, with rows in `docs/core-loop.md`
   and `docs/protocol.md`. Small, and it is Lyra's, not the playground's.

## The package

```
packages/playground/
  package.json            # unpublished, workspace, exports ./worker and ./recipes
  src/worker.ts           # the front door: assets, then /v1/*, plus the playground's own /api/sessions
  src/session.ts          # the Durable Object: createCloudflareSession + the script swap + the model slot
  src/index-do.ts         # the per-tenant session index (ids + labels + last used)
  src/budget.ts           # the per-tenant day cap
  src/model.ts            # MODEL_SOURCE: openrouter (default) | scripted; the picker's allow-list
  src/recipes/            # tool-table (the acceptance list), then fireside, then the rest
  web/                    # the SvelteKit app (adapter-static, SPA), built into dist/web
  wrangler.jsonc          # assets + DO bindings + migrations + vars
```

`packages/playground` is not published and not covered by the package budget; the example Worker keeps the
"is it still embeddable" job. The gate gains: its typecheck (`tsconfig.json` in the workspace typecheck
list), its build (SvelteKit + wrangler dry-run), and its own budget entry so a careless import cannot double
the deployment's size unnoticed.

## Slices

**Slice 1: the shell that deploys.** The workspace package, `wrangler.jsonc` with assets and the DO, the
front door that answers the asset route and hands `/v1/*` to `createSessionWorker`, and a page that is one
placeholder line. It deploys and `pnpm lyra start` works against it. Rows: the package builds, dry-run
bundles, budget holds.

**Slice 2: the token, the model, and one real run.** The token box, `localStorage`, the token-reset path
(403 `permission_denied` on HTTP, the socket upgrade's 401), the model
allow-list and `MODEL_SOURCE=openrouter` through the existing adapter with the key from a binding; a
`tool-table` recipe with `now` and `calculator`. The page starts a run, follows the SSE stream, and prints
the transcript. This is the first time Lyra does real work on a real deployment.

**Slice 3: the conversation.** Sessions in the sidebar (the index object, which also carries each
conversation's recipe), the **recipe picker at "new conversation"** over the recipes the Worker ships, a
session id in the URL, the transcript rebuilt from the record on load, steer/follow-up/stop, the status
line, and the record panel.
The stream resumes from `last-event-id` after a reload, and a conversation survives an eviction.

**Slice 4: tool calls and traces.** The tool-call list (name, arguments, result, duration, error, and several
in flight at once), and the thinking trace from `message_end.reasoning` while the run happens and from the
record afterwards. This is the slice that makes the page worth watching.

**Slice 5: the rest of the tools.** The acceptance table from #60, each with `defineTool` and a policy:
`notes_write`, `notes_read`, `notes_list`, `notes_delete`, `ask_person`, `fetch_page`, `search_web`, `flaky`,
`slow`, `big_result`, `hostile_page`, `propose_summary`, `finish`. Reads that fan out (a note lookup, a page
fetch) opt in to `parallel` so decision 154 is exercised by hand; writes ask. Every row gets a scenario file
(#59) so the same file runs in-process, through the fake server, over HTTP, over the socket, and against the
deployment.

**Slice 6: the cards.** The approval card (approve, deny with a note), the question card (typed answer or a
choice), the proposal card, and `list_pending` on load so a card raised while the page was closed is there
when it comes back. An approval answered after an eviction is the row that proves parking works on a real
object.

**Slice 7: the cap and the deploy.** The budget object and the day cap, with rows for a run under the cap, a
new run refused at it, and a day marked unpriced by a reply that reported nothing; `deploy.yml` on push to
`main` behind the gate, deploying with `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` and the model, token
and script keys as Worker secrets; and the smoke job, which starts a run with `x-lyra-script`, drives it over
the real protocol, and asserts the record — including a second run that answers an approval after an
eviction. The script boundary gets its own happy, sad and bad rows: a matching token starts the script, a
wrong one is `permission_denied` and starts nothing, an unset secret refuses the header, and a malformed or
oversized script is `bad_request`.

**Slice 8: the wrap-up.** `docs/playground.md` with the row tables, the decisions, the README's status,
`AGENTS.md`, `CHANGELOG.md`, and `notes.md`. The Lumen path (`MODEL_SOURCE=lumen`, the Lattice Worker) is
either demonstrated or recorded as unfinished with the reason, as #60 asks.

## The tool table, as the acceptance list

#60's table is the checklist, unchanged, plus four notes from this plan:

- A **conversation scenario** is part of the list, which is #60's own ask: one session, a run, a question
  answered, a follow-up run, and the assertions over the session's whole record. It cannot be written
  until prerequisite 2 lands, and it is the file that proves the sidebar and the cards rather than only
  the single-run tools.

- `now`, `calculator`, `read_page`/`fetch_page` and the notes reads opt in to `parallel`, so a group of calls
  shows up as several in-flight rows in the page.
- `hostile_page` matters more now that tools run in groups: the run must not obey it, and the test asserts
  the delete was never **approved**, not only that it did not run.
- `d1_query`, `r2_put` and `r2_get` come last, because they need bindings this rig does not need to test the
  loop, and #60 lists them as extras rather than as the acceptance list's core.

## Deploy

- One Worker, one name (decided at deploy time, e.g. `lyra-playground`), one Durable Object class for
  sessions and one for the index, one migration tag.
- Repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`. Worker secrets set by the workflow:
  `PLAYGROUND_TOKEN`, `OPENROUTER_API_KEY`, `PLAYGROUND_SCRIPT_TOKEN`. Vars: `PLAYGROUND_MODELS`,
  `PLAYGROUND_DAY_CAP_USD`, `PLAYGROUND_TENANT`, and `PLAYGROUND_SMOKE_TENANT` (a var, not a secret: it
  names the tenant scripts may run as, and the script door fails closed without it).
- A failed smoke job is red and does not roll back: this is a test rig, and a failed smoke on a rig is
  information rather than an outage.
- `wrangler deploy --dry-run` stays in the gate for size; the real deploy happens only on `main`, never in a
  pull request.

## What this is not

- **Not a product.** No accounts, no sharing, no billing, no design system; Grove's design system is
  Lattice's concern.
- **Not a coding agent**, and no shell or file tools: decision 1 stands, and those live in #43.
- **Not a second conversation model.** Fireside (#63) is the recipe this rig exists to serve; the page holds a
  conversation and shows a question, which is all Fireside needs from it.

## Open questions

- **The index's shape.** A per-tenant Durable Object is the simplest thing that lists sessions without D1;
  a D1 table is easier to query and one more binding to keep. The plan assumes the object, and the slice that
  builds it says why in a decision.
- **Whether the script swap lives behind a header or a whole separate model source.** A header keeps the
  smoke job on the same door a browser uses; a `MODEL_SOURCE=scripted` deployment would need a second Worker.
  The plan assumes the header, refused unless `PLAYGROUND_SCRIPT_TOKEN` matches.
- **How long a trace may be.** The entry cap (1 MiB) applies, and a tool result cap already exists; a
  reasoning trace is capped by `toolResultBytes`' sibling, which the slice that adds it decides.
