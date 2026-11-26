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
