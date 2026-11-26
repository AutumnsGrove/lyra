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
(`state: "done"`, `turns: 2`). The page holds one placeholder line, because the page is slice 2.

## Slice 1: the shell that deploys

One Worker, one Durable Object, one placeholder page, and a model that decides nothing. The page is served
from the Worker's own assets, so a browser talks to one origin; `/v1/*` is routed to the session object by
`run_worker_first`, because the assets layer's single-page fallback would otherwise answer a protocol route
with the page.

| ID    | When                                              | What happens                                                                                                                                                    |
| ----- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS01 | A request reaches the front door                  | A command with no token, or an unknown one, is refused `403`/`permission_denied` and the object is never asked; the token and tenant are read from the prefixed `LYRA_PLAYGROUND_*` bindings only, so a deployment still carrying the old unprefixed names refuses everything; a command with the token reaches the object named for that token's tenant; an unknown path under `/v1` is a `404` and wakes no object (a path outside `/v1` never reaches the Worker, because the assets answer it); and the entry point exports a class named `Session`, which is the name the configuration binds (its own delegation to the adapter is a deploy-time proof until slice 2) |
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
| PGS06 | The run a person starts                   | `tool-table` is the recipe the page starts: `now`, `calculator` and a `finish` whose done-check is real, and the session's recipe map carries it beside `shell`, keyed by the recipe's own name rather than the factory's. A scripted run through the loop calls both tools and ends `done`                                                                                                                                                                                                                  |
| PGS07 | The two tools                             | `now` answers the run's own clock, so a test pins it and a replay shows the same time the record holds. `calculator` adds, subtracts, multiplies and divides, and refuses a division by zero, a result that is not finite, and any arguments its schema does not allow, each as an error result the model can correct rather than a throw. Both change nothing, so both are `allow` and opt into running beside another call (decision 154) |
