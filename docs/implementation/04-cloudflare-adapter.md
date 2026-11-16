---
title: "Step 4: the Cloudflare adapter"
status: planning
category: features
---

# Step 4: the Cloudflare adapter

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-04-cloudflare-adapter`, from a `main` with step 3 merged. Builds decisions 12, 13, 72, 90, 101 and 102. It proves the core survives the real runtime: SQLite storage in a Durable Object, alarms for waking, and eviction at the worst moment, all in workerd.

Read: `docs/adapters.md`, `docs/decisions.md` 72, 101, 102 (the tooling, its four known issues, and the 1 MiB check this step owes), `docs/research/cloudflare-notes.md`, `docs/engineering-practices.md` ("Tools, and what is unconfirmed" and the catalog's "Cloudflare" list), and step 2's resume and wake code and the `storage.contract.testing.ts` from step 1.

Check the Cloudflare facts against the live docs before relying on them (`context7`, or the docs site). These were confirmed when this document was written, on 2026-11-16, so do not take them as permanent: `ctx.storage.sql.exec()` is synchronous and `ctx.storage.transactionSync(fn)` wraps a synchronous callback in a transaction that rolls back on a throw; `ctx.storage.setAlarm(ms)` replaces any alarm already set, and there is one alarm per Durable Object; a Durable Object class needs a `new_sqlite_classes` migration to get SQLite storage, and that cannot be added to an already-deployed class later; the Vitest plugin is `@cloudflare/vitest-plugin` and is configured with `cloudflareTest({ wrangler: { configPath } })`; bindings are read with `import { env } from "cloudflare:workers"` (the `env` from `cloudflare:test` is deprecated), and `cloudflare:test` still provides `runInDurableObject`, `runDurableObjectAlarm`, `evictDurableObject`, `evictAllDurableObjects` and `listDurableObjectIds`.

## Goal and done when

From `first-slice.md`: **in a workerd test, a Durable Object is killed mid-run and the run resumes.** For this step:

- `@autumnsgrove/lyra/cloudflare` exists as an entry point, with a `StorageSlot` over Durable Object SQLite (one row per entry), a `WakingSlot` over the alarm, and a `SecretsSlot` over Worker bindings;
- the same storage contract cases from step 1 pass against it, inside workerd;
- a full 1 MiB entry is saved to real Durable Object storage and read back, which turns decision 102's documented number into a fact (record the result in `decisions.md`, including what you find if it fails, and stop and tell Autumn if it does);
- a run killed by `evictDurableObject` at a chosen point resumes via the alarm and ends with the same record as an uninterrupted run, with an unsafe tool never run twice;
- `pnpm test:workers` exists and is part of `pnpm run ci`, and a small example Worker builds in CI so the library stays embeddable.

## Out of scope

The HTTP server and the session Durable Object that hosts a whole session (step 6), WebSockets and hibernation (step 8), the Lumen adapter, any deploy. Never run `wrangler deploy` or touch a Cloudflare account. `--dry-run` builds only.

## Settled here

**What the adapter exports,** and nothing more yet:
- `durableObjectStorage(ctx.storage, options?)`: a `StorageSlot`. A table `lyra_entries(seq INTEGER PRIMARY KEY, line TEXT NOT NULL)`, created if missing. `append` assigns the next `seq` and inserts inside `transactionSync`, so `seq` is gapless and ordered even if two appends race (they cannot interleave inside a synchronous transaction, which is the property the contract's concurrency row checks). `read` returns lines ordered by `seq`. Its `maxEntryBytes` is **well under** the 2 MB row limit (decision 102): reuse step 2's cap as the default and refuse anything larger with an error instead of letting SQLite throw.
- `alarmWaking(ctx.storage)`: a `WakingSlot`. `schedule(runId, atMs)` stores `runId` in a one-row table and calls `setAlarm`, `cancel` calls `deleteAlarm`. There is one alarm per object and one run active per session, which is why one row is enough (decision 72). The host's `alarm()` handler reads the run id and calls `runtime.wake(runId)`. Alarms are delivered at least once and retried if the handler throws, so the handler **must catch everything and never throw for a domain reason**. Step 2's idempotent `wake` is what makes a late, duplicate or concurrent alarm harmless, and this step tests that in the real runtime.
- `bindingSecrets(env)`: a `SecretsSlot` that returns a string binding by name and `undefined` for anything else (including a missing binding, a non-string binding, and a name like `__proto__`).

**Allowed imports for this entry point:** the core, and `cloudflare:workers`. Add `ENTRY_POINTS` row `cloudflare` to `scripts/importcheck.mjs`, teach the bare-import check to accept the `cloudflare:` scheme for this entry point only, and try it against deliberate violations (the core importing `cloudflare:workers`; the cloudflare entry importing `node:fs`; the cloudflare entry importing the testkit from production code). Types come from `@cloudflare/workers-types` or `wrangler types`, as a `devDependency`. Choose one, pin it, and record it in `decisions.md`. Pin `@cloudflare/vitest-plugin`, `wrangler` and `miniflare` exactly. Check peer ranges against Vitest 5 and TypeScript 7 at install time, and if they conflict, stop and report.

**Test layout.** Workerd tests are `*.workers.test.ts`. The Node config (`vitest.config.ts`) must **exclude** them, because its `include` is `packages/*/src/**/*.test.ts` and would otherwise pick them up and fail on `cloudflare:*` imports. Add `vitest.workers.config.ts` using `cloudflareTest({ wrangler: { configPath: ... } })`, with a test `wrangler.jsonc` and a small fixture Worker and Durable Object class under `packages/lyra/src/adapters/cloudflare/testing/`, named `*.testing.ts` (for example `fixture-worker.testing.ts` and `fixture-session.testing.ts`, and the test `wrangler.jsonc`'s `main` points at the first), so step 1's conventions keep them out of `dist`, out of coverage and the budget, and let them import the testkit, which production files in this entry point may not (kept under `src/` so `importcheck` still scans it for `node:*`, since the plugin injects `nodejs_compat` and a Node import would pass in workerd and fail on deploy, per decision 101). Coverage does not work in workerd (V8 coverage is unavailable), so the 85% floor stays on the Node run, and the workers config reports none. The fixture must not import dynamically inside a Durable Object handler (`import()` fails there). Add scripts `test:workers` and put it in the `ci` script after `test`. Check the CI runner for workerd: the job needs no extra setup if `pnpm install` brings the binary, but confirm, and keep parallelism low as `repository.md` says.

**The fixture Durable Object** is a test double for the step 6 session object: a class that builds a runtime over `durableObjectStorage`, `alarmWaking`, the scripted model and the fake clock from the testkit, exposes `fetch` to start a run and read the record, and has an `alarm()` that calls `wake`. The scripted model gets a **gate**: a way for the test to hold the run at a chosen point (for example "block inside the second model call until released") using promises, never a real sleep, so the test can evict the object while the run is mid-flight. Design the gate so the same script runs in Node and in workerd.

## Slices

**Slice 1: mechanics.** Entry point row, exports map, `devDependencies`, `vitest.workers.config.ts`, the test `wrangler.jsonc` with a `new_sqlite_classes` migration, `test:workers`, the exclusion in the Node config, and one smoke test that a trivial Durable Object runs under the plugin. Rows (prefix `CFL`, in `adapters.md`). The smoke test **also settles decision 103's open item**: write the first fast-check property test in workerd here (any trivial property), and record in `decisions.md` whether fast-check runs there. If it does not, say so and keep property tests on the Node suite; do not work around it.

**Slice 2: storage.** `durableObjectStorage`, running step 1's storage contract (`STO01` to `STO04`) inside workerd by calling the same `storage.contract.testing.ts` function. Extra rows: CFL01 a full 1 MiB entry saves and reads back byte for byte (decision 102); CFL02 an entry at the adapter limit saves and one byte over is refused without throwing; CFL03 a write failure surfaces as an error result (inject it by wrapping `ctx.storage` in the fixture, since SQLite will not fail on demand), and the run ends `failed` once; CFL04 concurrent appends from two requests get distinct ordered `seq` values; CFL05 data survives `evictDurableObject` (read after eviction returns what was written); CFL06 a damaged row (insert a malformed line with `runInDurableObject`) loads tolerantly through step 1's loader.

**Slice 3: waking.** `alarmWaking`, and the alarm handler in the fixture. Rows: CFL07 `schedule` then `runDurableObjectAlarm` fires the handler once; CFL08 `schedule` twice replaces the first (one alarm); CFL09 `cancel` means no alarm runs (`runDurableObjectAlarm` returns false); CFL10 an alarm that fires after the run finished does nothing; CFL11 an alarm delivered twice resumes once; CFL12 an alarm that fires while the run is live in the object does nothing (hold the run on the gate, fire the alarm, assert no second loop); CFL13 the handler never throws even when the record is unreadable (the run parks or fails, and the handler returns).

**Slice 4: the kill test.** The one this step exists for. Rows: CFL14 a run held mid-flight on the gate, object evicted, alarm fired, run resumes and ends `done`; CFL15 the same at each of several chosen points (before the model request, after the assistant message, during a tool, before the result is saved), using the gate and the fixture's ability to stop the storage at the *n*th append in the style of step 2's `crashingStorage`; CFL16 an unsafe tool in flight at eviction is never run twice and the model is told the outcome is unknown; CFL17 the resumed record equals the uninterrupted run's (reuse step 2's comparison, ignoring the `resumed` and unknown-outcome entries); CFL18 the half-built `timeline-test` page and its handle table equal the uninterrupted run's after a kill (step 3's recipe, now in the real runtime). Eviction in tests is faithful to production: workerd drops in-memory state.

**Slice 5: secrets.** `bindingSecrets`. Rows: CFL19 a binding is returned; CFL20 a missing binding is `undefined` and a tool that needs it returns an error result naming the secret **but never its value**; CFL21 a non-string binding and a prototype-ish name are `undefined`. Assert, in a test of the tool's error, that no binding value appears anywhere in the record.

**Slice 6: the example and the size budget.** `examples/workers-minimal/`: a Worker plus a Durable Object that uses the core, the Cloudflare adapter and a scripted model, with its own `wrangler.jsonc` and a `package.json` in the workspace. Add a build step to the `ci` script that runs `wrangler deploy --dry-run --outdir <dir>` (or the current equivalent, verify) and fails if it fails. **Never without `--dry-run`.** Extend `scripts/budget.mjs` and `budgets.json` to report the gzipped size of that bundle against a ceiling you set after measuring (leave headroom, and say how you chose it), because "watch the Workers bundle size" (`AGENTS.md`) needs a number to watch. Also revisit the whole-package 40 KiB budget now that an adapter exists: report the figure, and if you split the measurement per entry point, say so in the commit.

**Slice 7: wrap-up.** `adapters.md` (rows, and the note on one alarm per session), `overview.md`, `engineering-practices.md` (the tooling items now confirmed: fast-check in workerd, the 1 MiB result), `decisions.md` (the results of CFL01 and the fast-check check, the pinned versions, 104 onward), README status, `AGENTS.md` (`pnpm test:workers` now exists), `CHANGELOG.md`.

## Cases to work through from the catalog

"Cloudflare": a Durable Object evicted at each point above, an alarm that fires late or twice or while a request is running, a storage write failure, a record at the size limit for a row, a tool that uses a binding that is missing. From decision 101's issues: V8 coverage is unavailable, WebSocket tests need isolation off (not yet), fake timers do not reach the KV, R2 and cache simulators (unused), and `import()` fails inside a Durable Object handler. From decision 102: the row limit is 2 MB on the live page and 8 MB on its markdown copies. CFL01 is the check that does not depend on which is right.

## Judgment calls already made

One table, one row per entry. One alarm row, one run per session. The adapter refuses oversize lines rather than relying on SQLite to. The fixture is a test double and is not exported. `bindingSecrets` is tiny on purpose and only reads string bindings. Cloudflare's agent tooling is not used (decision 72).

## Mechanics changed in this step

`importcheck` (entry point, `cloudflare:` scheme), `package.json` `exports` and scripts, a workers Vitest config, the Node config's exclusion, `ci` script (adds `test:workers` and the example build), `budget.mjs`, `.gitignore` already ignores `.wrangler/` and `.dev.vars`. New pinned devDependencies: the plugin, `wrangler`, `miniflare` if the plugin needs it, and Workers types. If install or the plugin misbehaves in a way this document did not predict, record it in `notes.md` before working around it.
