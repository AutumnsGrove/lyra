# Lyra

A small, portable agent core for Grove.

> A small constellation that does the work while the grove sleeps.

Lyra runs a loop: ask the model what to do, run a tool, hand the result back, repeat until the job is
done. It is a tool-calling agent. It is not a coding agent and never will be. It has no subagents and
no skills.

It is also the name of the agent itself, the way Nova is both the harness and the thing you run.
Features are "powered by Lyra".

## Status

**Building.** Step 1 of the first slice is complete and merged: the core runs end to end against fakes,
with the record, the memory adapter, the testkit and the scenario files. Step 2, limits, retries and
resume, is in progress. Version one, and the timeline job running on it, is the checkpoint
(`docs/first-slice.md`).

A new session should read [`AGENTS.md`](AGENTS.md), then "Where the last session stopped" in
[`docs/implementation/README.md`](docs/implementation/README.md), then `docs/implementation/notes.md`.
Those three say exactly what is done, what is next, and what was chosen along the way.

## Where the design lives

Read [`docs/overview.md`](docs/overview.md) first. It is the front door: what Lyra is, how the pieces
fit, in plain words, with a pointer to each detail.

[`docs/decisions.md`](docs/decisions.md) has all 108 decisions with their reasons. Check it before
reversing something that looks odd.

| Document                                                          | What it holds                                                 |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| [`overview.md`](docs/overview.md)                                 | **Start here.** The whole shape, in plain words.              |
| [`decisions.md`](docs/decisions.md)                               | Every decision so far, with the reason. The source of truth.  |
| [`adapters.md`](docs/adapters.md)                                 | The four slots, the optional shell, and Grove's adapters.     |
| [`limits-and-interruptions.md`](docs/limits-and-interruptions.md) | What stops a run, and how it resumes.                         |
| [`run-record.md`](docs/run-record.md)                             | The saved record of a run.                                    |
| [`approvals.md`](docs/approvals.md)                               | Asking a person for a yes or an answer.                       |
| [`context-size.md`](docs/context-size.md)                         | Compaction.                                                   |
| [`protocol.md`](docs/protocol.md)                                 | How anything outside talks to Lyra.                           |
| [`shell-tool.md`](docs/shell-tool.md)                             | The optional shell.                                           |
| [`consumers.md`](docs/consumers.md)                               | Who uses Lyra.                                                |
| [`timeline-first-job.md`](docs/timeline-first-job.md)             | The first job: the development timeline summary.              |
| [`lumen-changes.md`](docs/lumen-changes.md)                       | What Lumen has to change first.                               |
| [`engineering-practices.md`](docs/engineering-practices.md)       | How it is built and tested.                                   |
| [`first-slice.md`](docs/first-slice.md)                           | The build order.                                              |
| [`repository.md`](docs/repository.md)                             | Layout, releases, and how the plan moved here.                |
| [`agents-guide.md`](docs/agents-guide.md)                         | The draft the root `AGENTS.md` came from.                     |
| [`research/`](docs/research/)                                     | Raw notes from 2026-11-11. Source material, not settled fact. |

## Working here

```bash
pnpm install    # dependencies (pnpm, not npm or bun)
pnpm test       # the fast loop
pnpm run ci     # the full gate: the definition of done
```

There is no command to run yet: the first one, `pnpm lyra start`, arrives with the protocol in step 6.
Until then the library is used from TypeScript, and `scenarios/` is how a run is tried by hand. [`AGENTS.md`](AGENTS.md) has the rules for changing anything here, and `.github/workflows/ci.yml`
runs the same gate.

## Repository layout

| Where                         | What lives there                                        |
| ----------------------------- | ------------------------------------------------------- |
| `packages/lyra/src/core/`     | the loop, recipes, tools, limits                        |
| `packages/lyra/src/record/`   | record entries, replay, resume                          |
| `packages/lyra/src/protocol/` | frames, commands, events                                |
| `packages/lyra/src/adapters/` | `memory`, `cloudflare`, `openai`                        |
| `packages/lyra/src/testkit/`  | test support only, but published                        |
| `scenarios/`                  | the YAML scenario files                                 |
| `examples/workers-minimal/`   | a small Workers consumer, built in CI                   |
| `scripts/`                    | `importcheck`, `matrixcheck`, `budget`                  |
| `docs/`                       | the specs, with a row table in each, and `decisions.md` |

The package is `@autumnsgrove/lyra`, one package with subpath exports per entry point, each with its
own allowed imports (`docs/decisions.md`, decisions 69 to 71). Only the core entry point exists so
far; the others arrive with the adapter they belong to.

## History

The plan lived in Lattice while it was being written, and moved here once the scope was clear (PR
#1695 in [AutumnsGrove/Lattice](https://github.com/AutumnsGrove/Lattice)). The issues stay there:

- [#1605](https://github.com/AutumnsGrove/Lattice/issues/1605): the design issue, with a design-update comment
- [#1693](https://github.com/AutumnsGrove/Lattice/issues/1693): the Lumen changes for the Model slot, landed 2026-11-17
- [#1687](https://github.com/AutumnsGrove/Lattice/issues/1687): the timeline vine page change, separate from Lyra
- [#1684](https://github.com/AutumnsGrove/Lattice/issues/1684): HawkAgent, the second consumer

The naming journey that ended at Lyra is in
[`agent-core-naming-journey.md`](https://github.com/AutumnsGrove/Lattice/blob/main/docs/philosophy/naming-research/agent-core-naming-journey.md).

## License

MIT. See [`LICENSE`](LICENSE).
