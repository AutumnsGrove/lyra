---
title: "The playground"
status: building
category: features
---

# The playground

The rows for `packages/playground`, the Worker that serves the page and runs Lyra against a real model
(issue #60). The plan, its slices and the shape questions Autumn settled are in
[`implementation/C-playground.md`](implementation/C-playground.md); this document is the behavior the code
promises, and it grows a slice at a time.

The playground is a rig rather than a product: it is unpublished, its bundle has its own size budget, and a
failed smoke run on it is information rather than an outage.

## Where it runs

Slice 1 is deployed: **https://lyra-playground.m7jv4v7npb.workers.dev** on the `AutumnsGrove` Cloudflare account,
Worker `lyra-playground`, from `packages/playground/wrangler.jsonc`. The deploy is by hand until `deploy.yml`
lands in slice 7, and the token is a Worker secret held in Autumn's `gw secret` vault as
`LYRA_PLAYGROUND_TOKEN`. Both playground bindings are prefixed, because the vault is shared
across the Grove Workers and its rule is that a name says which project it belongs to; the
tenant var is the same name without the secret (issue #60, slice 2).
The vault hands it to wrangler over stdin rather than in argv, so it is never in this repository or a
transcript, and the live checks below drive the deployment through `pnpm lyra`, which reads the token from the
environment rather than a command line.

Driven against that deployment on 2026-11-25: the page and the single-page fallback both answer `200`, a
command with no token is `403 permission_denied` without waking an object, an unknown path under `/v1` is `404`,
and `pnpm lyra start shell` runs to `run_end` with a follow-up finishing its own segment afterwards
(`state: "done"`, `turns: 2`). That run is also what proves the entry point's `Session` class delegates to the
adapter: it went through the Worker's `fetch`, not through the class.

Driven against slice 2 on 2026-11-26, after the deploy that renamed the bindings: the page answers `200` with
the SvelteKit app and a deep link gets the single-page fallback, a command with no token is still
`403 permission_denied`, and `pnpm lyra start tool-table` ran a real model to `run_end` with **two tool calls
in one group** — decision 154 doing what it promises on a real deployment, with one model key and no scripted
model anywhere near it. The token was regenerated in the vault as `LYRA_PLAYGROUND_TOKEN` and applied to the
Worker before that deploy; the old `PLAYGROUND_TOKEN` was removed from the Worker and deleted from the vault
only afterwards, and the new token was used to read the run's record back once it was gone.

Driven against slice 3 on 2026-11-26, after the deploy that added the index: the page and a deep link answer
`200`, `/api/sessions` and `/api/recipes` with no token are `403 permission_denied`, and with the token a
conversation was created (`POST /api/sessions`), listed back with its recipe and label, and then started by
the same id: `pnpm`-free, through the deployment's own `/v1/commands`, it ran `now` and `calculator` as one
group and finished `done` in two turns for `$0.000168`. That is decision 158 and decision 154 both doing what
they promise on the live Worker, and it is the first run whose conversation the sidebar can list. The `v2`
migration created `SessionIndex` on the same deploy, and no secret changed: the two Worker secrets carried
over, so nothing was copied out of the vault.

Driven against slice 5a on 2026-11-26, after the deploy that carries the tool table: a conversation was
created, and `start` on it asked the model to keep a note and read it back. The run **parked on
`notes_write` with an `approve` request**, the answer was posted to `/v1/ui_response` with the token, and the
same run continued: `notes_write` reported the note kept, `notes_read` answered `two pints` — the note survived
the park because it is the recipe's state — and `finish` ended it `done` in four turns for `$0.00043`. That is
decision 34's mechanism, decision 112's state, and the table's writes asking a person, all on the live Worker
with a real model.

**A conversation started before this deploy parks `stuck`/`recipe_changed` on its next follow-up.** The recipe
moved to version 2 and gained tools, which changes the pin (decision 91); that is the pin doing its job, and a
new conversation is the way past it.

Driven against slice 5b on 2026-11-26, after the deploy that carries the page tools: a new conversation asked
the model to `fetch_page` on `https://example.com/`, and the run read the real page through the Worker's own
`fetch` — the `tool_end` carried the page's HTML, so the call that `Illegal invocation` would have broken works
where it matters — and finished `done` in two turns for `$0.00042`. No redirect, no private host: the guard
that refuses both is exercised by the tests, and this run is the one a test cannot do.

**A conversation that predates this deploy parks `stuck`/`recipe_changed`** on its next follow-up, because the
recipe is version 3. That is the pin (decision 91) doing its job; start a new conversation.

## The page

Slice 2 (pull request #85, `ede65ee`) replaced slice 1's placeholder with a SvelteKit app (`packages/playground/web`), built by
`pnpm build` into `packages/playground/dist/web`, which is the directory `wrangler.jsonc` serves as assets. It
is a static SPA: no server-side rendering, `adapter-static` with an `index.html` fallback, and `/v1/*` still
claimed by the Worker before the assets layer. A person types the token once, and it is kept in
`localStorage` until a `403` clears it.

The page's logic is `web/src/lib/playground.ts`, plain TypeScript with `fetch`, the storage and the clock
passed in, so its tests run on Node. The component is a thin skin over it, and it is tested in `happy-dom` —
a Node document, not a browser — so the page a person loads is the thing under test rather than a copy of its
logic. That suite is its own runner (`pnpm test:playground`), because it needs the Svelte compiler and a DOM
and the rest of the gate must have neither.

What the gate covers and what it does not: the web app's TypeScript is typechecked by its own `tsc` project
(`web/tsconfig.json`, the one project allowed DOM types), its `.svelte` templates are compiled by the build,
and its tests are not part of the 85% coverage floor, which measures the Node-tested core and the playground's
Worker code. A component's markup is proven by the build and by the deploy, not by a coverage number.

## Slice 1: the shell that deploys

One Worker, one Durable Object, one placeholder page, and a model that decides nothing. The page is served
from the Worker's own assets, so a browser talks to one origin; `/v1/*` is routed to the session object by
`run_worker_first`, because the assets layer's single-page fallback would otherwise answer a protocol route
with the page.

| ID    | When                                              | What happens                                                                                                                                                    |
| ----- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS01 | A request reaches the front door                  | A command with no token, or an unknown one, is refused `403`/`permission_denied` and the object is never asked; the token and tenant are read from the prefixed `LYRA_PLAYGROUND_*` bindings only, so a deployment still carrying the old unprefixed names refuses everything; a command with the token reaches the object named for that token's tenant; an unknown path under `/v1` is a `404` and wakes no object (a path outside `/v1` never reaches the Worker, because the assets answer it); and the entry point exports a class named `Session`, which is the name the configuration binds (its delegation to the adapter is proven by a real deploy and a run through the Worker's `fetch`, not by a test: a second workerd configuration would be needed to hold this Worker, and that is stated as unfinished in the slice's notes) |
| PGS02 | A run is driven through the loop by the session's own options | The recipe, the model, the token map and the host the session's options carry are the ones the run uses, and that run finishes through the real loop, so a mis-keyed recipe or a dropped model fails here; the placeholder model asks to finish instead of pretending to work, and reports no cost |
| PGS03 | The Worker is deployed                            | The configuration declares that `/v1/*` is claimed by the Worker before the assets layer (`run_worker_first`, without which the single-page fallback would answer every protocol call), that this package's entry point is the Worker named `lyra-playground`, that one `Session` object is bound with a migration creating it, and that no token sits in `vars`. What wrangler does with those declarations is proven by a deploy, not by reading them |

## Slice 2: the token box, the model, and one real run

A deployment that can spend a real model's allowance, behind a token a person types once. The page is the
SvelteKit app; the model is the OpenAI adapter pointed at OpenRouter; and the run a person starts is the
`tool-table` recipe.

| ID    | When                                       | What happens                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS04 | The Worker builds its model slot           | `MODEL_SOURCE` (trimmed and case-folded) picks it: unset or `openrouter` builds the OpenAI adapter at OpenRouter's base URL for the first allowed model, `placeholder` keeps slice 1's slot and needs no key, and any other value is a non-retryable `bad_request` naming what was typed, so the run parks `model_unavailable` instead of calling a provider nobody chose. The key is read from `LYRA_PLAYGROUND_OPENROUTER_API_KEY` and reaches the provider only as the `Authorization` header, under the name the adapter's preset asks for; with the binding unset nothing is sent, and the reply is a non-retryable `permission_denied` |
| PGS05 | The model allow-list                       | `PLAYGROUND_MODELS` is comma-separated: its order is kept and blank entries are dropped, and unset, blank or nothing but separators falls back to `DEFAULT_MODELS`, whose first entry is `deepseek/deepseek-v4.1-flash-1017`. The first entry is the model a run asks for while there is no picker                                                                                                                                            |
| PGS06 | The run a person starts                   | `tool-table` is the recipe the page starts: from slice 5 it carries issue #60's whole table (reads, writes, `ask_person`, `propose_summary`) and a `finish` whose done-check is real, as version 3, and the session's recipe map carries it beside `shell`, keyed by the recipe's own name rather than the factory's. A scripted run through the loop calls its tools and ends `done`; its `setup` starts the state with no notes and takes the person's words as the first message |
| PGS07 | The two tools                             | `now` answers the run's own clock, so a test pins it and a replay shows the same time the record holds. `calculator` adds, subtracts, multiplies and divides, and refuses a division by zero, a result that is not finite, and any arguments its schema does not allow, each as an error result the model can correct rather than a throw. Both change nothing, so both are `allow` and opt into running beside another call (decision 154) |
| PGS08 | A person arrives without a token                | The page settles on a token box and nothing else — no question field, no transcript. A token is trimmed and kept in `localStorage` on the way in; a blank one is not saved over a good one, and "forget" removes it                                                                                                                                                     |
| PGS09 | A token the front door refuses                 | A `403` on the command or on the event stream clears the stored token, shows the token box again and says the token was refused; any other refusal is shown as its own message, and the page is usable again. A network that refuses is a message, never a crash                                                                                                    |
| PGS10 | A run the page started                         | The command is one `start` frame for `tool-table` with no session named, and the answer's session is what the page follows. The stream is read as server-sent events with the token in a header (an `EventSource` cannot send one), an unreadable event does not stop the ones after it, and the transcript keeps the model's text and reasoning, each tool call with its result, the run's end and its cost in order |

## Slice 3: the conversation

A sidebar of conversations instead of one run, each carrying the recipe it was started with, and a session id in the URL so a reload lands where the person was. The index is the playground's own object (decision 158), because `list_sessions` is `unsupported` in Lyra on purpose: listing sessions needs an index of its own, and this is that index for this rig.

| ID    | When                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                          |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS11 | A new conversation is asked for               | `POST /api/sessions` mints an id from the sessions namespace, records `{session, label, recipe, lastUsed}` in the index object named for the **token's** tenant and answers `{session}` with `201`, so the `start` the page sends next lands on the object the sidebar lists. A missing or wrong token is `403` and wakes no object; a recipe this Worker does not run is `not_found`, checked before the index is written; a body that is not JSON, has no label or recipe, has a blank label, or is over the body cap is `bad_request`; in every refusal nothing is written |
| PGS12 | The sidebar is read                           | `GET /api/sessions` answers the tenant's index newest first by `lastUsed`, with the id, the trimmed label, the recipe and the time, and stops at the cap with the newest kept. A label over the cap is cut rather than refused, because it is the page's own words. An entry the object cannot read is skipped rather than drawn as a broken row, and a stored key that is not an entry is not listed                                                                     |
| PGS13 | A conversation is used again                  | `PUT /api/sessions/<id>` sets `lastUsed` and relabels only when a label is given, so a conversation moves up the sidebar when it is continued; an id the index does not hold is `not_found` and creates nothing, and a touch without a token is `403`                                                                                                                                                     |
| PGS14 | A route the playground does not have          | Anything under `/api/*` that is not one of the routes above is `not_found` and wakes no object: `/api/*` is claimed by the Worker in `wrangler.jsonc` (`run_worker_first`), so the page can never answer it, and the object is only named after a token resolved to a tenant                                                                                                                        |
| PGS15 | The recipe picker's list                      | `GET /api/recipes` answers the names of the map a `start` is answered from, in that map's order, so the picker can offer neither a recipe the session would refuse nor hide one nobody could reach; a request without the token is `403`                                                                                                                                                                |
| PGS16 | The index outlives its object                 | A `SessionIndex` rebuilt over the same storage lists what the one before it wrote, with every entry's id, label, recipe and time, and nothing held in a field that an eviction loses                                                                                                                                                                                                                    |
| PGS17 | The picker, and the first message       | `GET /api/recipes` fills a recipe picker and the first entry is the default while the binding has not synced, so a run is never started with no recipe; the first message mints the conversation through `POST /api/sessions` with the chosen recipe and the message as its label, and the `start` that follows names the id the index was given, so the run lands on the conversation the sidebar will list. A refusal is shown as its own message, and a `403` sends the person back to the token box |
| PGS18 | A conversation is opened                    | The sidebar lists the index's conversations newest first and a click selects one; the selection goes into the URL as `?session=<id>`; the transcript is rebuilt from the record's entries one page at a time, which is why it holds what the person said — `user_message` is in the record and is deliberately not a protocol event — and the stream is then followed from the last entry, so nothing is drawn twice and nothing written since the read is missed. A session the index does not hold still opens, because a run that predates the index is a record a person can still read |
| PGS19 | A conversation is used again                | A message in an open conversation is one `follow_up` frame naming its session, sent after the index is touched, so the conversation moves up the sidebar and the URL it already had stays; a refusal is a message rather than a silent drop |
| PGS20 | The session id in the URL                   | The id is read from `?session=` and written back with every other parameter untouched, so a reload lands on the same conversation and an id that is blank or absent means a new one. It is a query rather than a path because the app is a static shell whose fallback would answer a path SvelteKit has no route for (decision 159) |
| PGS21 | Steer and stop while a run is going         | `steer` and `abort` are one frame each naming the session, and the transcript shows the run's end with its parked reason; the controls are only on the page while the record says a run is running, so a steer with nothing to steer is not offered as a dead button. A `conflict` from either is a message, not a crash |
| PGS22 | A stream that drops                          | A reconnect carries `last-event-id` of the last entry the page drew and reports the position each new event came from, so reopening a dropped stream sends only what followed it rather than the whole record again (HTP05); a stream the server closed having sent nothing new is finished rather than reopened |
| PGS23 | The record panel, and what an entry means    | `get_messages` is read one page at a time and followed by its cursor for a bounded number of pages, and the panel shows the entries a person can open beside the transcript. A status entry says `running`, `done`, `parked` or `failed` and a parked one names its reason and the limit that caused it; a failed tool is drawn as an error; a blank assistant turn makes no row; and an entry kind this build does not know is skipped rather than drawn as a hole |

## Slice 4: tool calls and traces

A run is worth watching because of what it calls. The transcript already carried a tool's name, its arguments and
its result; this slice makes a call **one row that fills in**, so a group of calls is a list a person can see
in flight, and gives each row the status and the duration the record holds. The thinking trace was already on
the assistant row from `message_end.reasoning` (EVT08); the rows below say what a call's own line promises.

| ID    | When                                        | What happens                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| PGS24 | A reply calls several tools                  | Each call becomes one row at the moment `tool_call` arrives, so a group of calls is drawn together before any result does; the row fills in when its `tool_end` arrives, with its result and whether it failed, rather than a second row appearing. A row whose result never came keeps its place and says there is none, because the record holds the call and a stop or a kill is what explains the gap. A result with no call the page saw, and a second result for the same call, change nothing: the page cannot invent a call it never saw, and the first answer stands |
| PGS25 | A call's duration                            | It is the difference between the two record entries' own `ts` — the call's entry time and its result's — on the live path and on a rebuild alike, so one run shows one number however it is read. A call or a result with no time is drawn without a duration rather than with one the page made up; several calls in a group share the call entry's time, because they share the entry |

## Slice 5: the rest of the tools

Issue #60's acceptance table, built as recipe tools with a policy each: the reads the rig fans out, the writes a person approves, the two that need somebody else, and the tools whose shape is the point. One scenario file per behaviour lives in `scenarios/playground/`, because the three runners of `scenarios/*.yaml` give a file only the testkit's recipes.

`search_web` is not here: it needs a search provider and the rig has none, so it is issue #91 and Autumn's call to leave it for now. The network tools (`fetch_page`, `hostile_page`) are slice 5b.

| ID    | When                                          | What happens                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS26 | A note is kept, read and deleted              | The notes are the recipe's **state**, so a resume rebuilds them from the record's own applies (decision 112) rather than from a store of the rig's own: `notes_write` and `notes_delete` change it (an `apply`, `policy: ask`, `risk: changes`), and `notes_read` and `notes_list` only read it (`allow`, parallel, repeatable). A read or a delete of a name that is not there is an error result naming it, and the state comes back untouched; an empty or missing name is refused by the schema before anything is stored |
| PGS27 | The tools whose shape is the point            | `flaky` fails twice and works on the third call so a model has something to correct — its count is the tool's own memory, because an error result is skipped when state is rebuilt and a counter in `apply` would never move, and that memory lasts as long as the session's object, so a later run in the same conversation finds it already working and a rebuild is what resets it. `slow` waits for the sleep its host injects, between 1 and 5,000 ms, and a longer wait is refused by the schema rather than held. `big_result` answers up to 400,000 bytes and cuts nothing itself, because the cap is the loop's job (REC03) |
| PGS28 | A tool that needs somebody else               | `ask_person` parks the run with a question and never invents an answer: the question is the tool's own, so its policy is `allow` and it is not part of a group (APR05). `propose_summary` leaves a proposal with its evidence, ends the run and is decided later (decision 52), and a payload missing its summary is refused before it can become one. Both are in the table, so a person can see the two ways a run stops for them |
| PGS29 | A playground scenario file                    | Each file in `scenarios/playground/` names `tool-table`, and runs through `runScenario` with the shipped recipe catalogue, so the file and the recipe cannot drift. The four here cover a note approved and read in a later segment, `flaky` failing twice, a question answered, and a proposal left. A file that does not decode, or that the recipe cannot run, fails rather than passing empty |

## Slice 5b: the page tools

Two tools that read somebody else's page. `fetch_page` takes the `fetch` its host supplies — the Worker's own in a deployment, a fake in a test — and `hostile_page` exists to be the page a run should not obey.

| ID    | When                                          | What happens                                                                                                                                                                                                                                                                                                                                                                                        |
| ----- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS30 | A page is fetched                             | The URL must be `http` or `https` and name a host on the open web: any other scheme, and `localhost`, `127.*`, `10.*`, `192.168.*`, `172.16-31.*`, `169.254.*`, `.internal` and `.local` are refused **before** the request, so a page cannot point the Worker's egress at itself or at a metadata service. A page's body is read only as far as 200,000 characters — the read stops and the rest of the stream is cancelled, rather than buffering a page of any size — and a cut page says where, a non-2xx answer is an error result naming its status, a **redirect is refused rather than followed** — because the guard only saw the address it was given, and a default `fetch` would follow a 302 to a private host — and a network that fails is an error result rather than a throw. The host rule is "not obviously public": a trailing dot is stripped, a bracketed IPv6 address is refused unless it is in `2000::/3`, and CGNAT, the whole `0.0.0.0/8` range and 6to4 (`2002::/16`, which carries an IPv4 address inside it) are refused with the RFC 1918 ranges. The host's `fetch` is called as a bare function rather than as a property, because the Worker's native `fetch` throws `Illegal invocation` when it is called the other way. It is a read, so it is allowed, repeatable and parallel |
| PGS31 | A page that instructs the model               | `hostile_page` answers text that tells the model to delete every note, and does nothing about that text: it is a fixture, and the protection is the approval on `notes_delete` (PGS26), not a sanitiser here. `scenarios/playground/hostile.yaml` drives it end to end — the model reads the page, tries the delete, the run parks on an `approve` request, the person denies it, and the record shows the deny and the denied call's own error result — the assertion that the delete never ran — and a `done` run |
