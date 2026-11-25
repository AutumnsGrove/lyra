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

## Slice 1: the shell that deploys

One Worker, one Durable Object, one placeholder page, and a model that decides nothing. The page is served
from the Worker's own assets, so a browser talks to one origin; `/v1/*` is routed to the session object by
`run_worker_first`, because the assets layer's single-page fallback would otherwise answer a protocol route
with the page.

| ID    | When                                              | What happens                                                                                                                                                    |
| ----- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PGS01 | A request reaches the front door                  | A command with no token, or an unknown one, is refused `403`/`permission_denied` and the object is never asked; a command with the token reaches the object named for that token's tenant; a path outside `/v1` is a `404` |
| PGS02 | A run is started on the deployment                | The recipe and the model the session's own options carry finish a run through the real loop, so a mis-keyed recipe or a dropped model fails here; the placeholder model asks to finish instead of pretending to do work, reporting no cost |
| PGS03 | The Worker is deployed                            | The configuration keeps `/v1/*` away from the page (`run_worker_first`, without which the single-page fallback answers every protocol call), deploys this package's entry point as `lyra-playground`, binds one `Session` object with a migration that creates it, and keeps the token out of `vars` |
