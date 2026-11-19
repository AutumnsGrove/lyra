---
title: "Step R: the release workflow and the release-notes script"
status: in review
category: features
---

# Step R: the release workflow

Last updated: 2026-11-19, at review. Read [`README.md`](README.md) first. Branch: `feat/step-R-release-workflow`. Builds decisions 71, 74, 75, 76, 99 and the "Releasing" section of `AGENTS.md`. Source material is Nova's, read-only, at `~/Documents/Projects/nova/.github/workflows/release.yml` and `~/Documents/Projects/nova/scripts/release-notes/` (`main.go`, `prompt.md`, `main_test.go`). Nova's script is Go, and Lyra has no Go, so this is a port of its behavior, with its tests ported first.

## Goal and done when

A tag `vX.Y.Z` on `main` runs the gate, publishes `@autumnsgrove/lyra` to npm over OIDC with provenance, and creates a GitHub release whose body an agent wrote from the changelog section and the commit log, with a fallback chain so the body never blocks the release. A manual dry run rehearses everything except publishing.

**State at review (2026-11-19).** Slices 1 to 3 are built: the script with its rows in
`docs/release-notes.md` and a fake agent, the workflow, and the docs. The gate is green. Two items in
"Done when" are Autumn's and wait on the merge: `workflow_dispatch` only lists a workflow that exists on
the default branch, so the dry run cannot be dispatched from the branch, and it is the first thing to do
on `main` afterwards. Nothing was published, no tag was pushed, and no npm setting was touched.

Done when:
- the script's tests pass, covering every fallback path with a fake agent and no model;
- `release.yml` passes `actionlint` (or a careful read, if it cannot be installed) and the **dry run** has been run once on the branch by Autumn, producing a body in the job summary. You cannot run a workflow dispatch yourself without pushing, so push the branch, open the PR, and ask her to run it (a dispatch needs the workflow on the default branch to appear in some setups; say which you found);
- nothing was published and no tag was pushed.

## Out of scope

Publishing for real, creating the tag, configuring the trusted publisher on npmjs.com (Autumn's job, below), and drafting changelog entries by an agent (declined in decision 74).

## Needs Autumn, so ask early

- **npm trusted publishing is configured in the npm UI** for `@autumnsgrove/lyra`: repository `AutumnsGrove/lyra`, workflow `release.yml` (decision 99). Whether npm lets her configure a trusted publisher for a package that has never been published is something to verify against npm's current docs (use `context7` or the web), and if the first publish needs a token, that is a decision for her. Write down what you find in `notes.md`. Do not work around it.
- The repository secret `PI_REVIEW_API_KEY` already exists for `pi-review` (decision 77). The notes step maps it to `OPENCODE_API_KEY`. Confirm it exists with `gh secret list`, never read its value.

## Judgment calls made in advance

- **The release PR bumps the version.** `AGENTS.md`'s release procedure edits `CHANGELOG.md` but never says who changes `packages/lyra/package.json`'s `version`, which the tag job publishes from. The simplest consistent answer: the release PR sets `packages/lyra/package.json` to the new version, and the workflow's first step fails the run if the tag (minus `v`) does not equal that version. A publish that disagrees with its tag is worse than a failed release. Update `AGENTS.md`'s "Releasing" step 3 to say so, in this PR.
- **TypeScript, run with Node's built-in type stripping.** Decision 74 says the script is TypeScript. The Node floor is 22.19, and type stripping is on by default from 22.18, so `node scripts/release-notes/main.ts` runs with no build step. Verify that on the installed Node before relying on it. It means erasable syntax only (no `enum`, no `namespace`, no constructor parameter properties), `import type`, and `.ts` extensions in relative imports, which needs `allowImportingTsExtensions` (it can sit alongside `noEmit`) in a `tsconfig` that includes `scripts/release-notes/`. If that turns into a fight, fall back to compiling with `tsc` into a temporary directory in the workflow, and record the fallback.
- **No dependencies.** `node:child_process`, `node:fs`, `node:path` only. `scripts/` is outside `src/`, so `node:*` is allowed there.
- **Same agent, same pins as `pi-review`:** provider `opencode-go`, model `deepseek-v4.1-flash`, thinking `high`, Pi `1.5.2` (what `.github/pi-review.json` pins), tools `read,grep,find,ls,bash` (decision 76 kept `bash`), 12 minute limit inside a 15 minute step limit, 16 KiB cap on the body. Copy Nova's pi flags exactly, and test that they are passed.
- **Exit codes as Nova's:** `0` the agent's body was used, `3` the body came from the fallback, `2` a usage or setup error. The workflow turns `3` into a warning, so a silent fallback cannot hide.
- **Fallback chain:** agent output, then the changelog section, then no body. Any of these publishes the release. A bad install of Pi, a timeout, a crash, an empty or oversized answer, or an answer with no headings or bullets falls through.

## Slices

### Slice 1: the script, test-first, in the test layout Lyra already has

Ground rules first. Add `scripts/release-notes/` with `main.ts`, `prompt.md`, and `main.test.ts`. Vitest's `include` covers only `packages/*/src/**`, so add `scripts/**/*.test.ts` to `vitest.config.ts` (the script's tests use `node:fs` and `node:child_process`, so they must not live under `src/`). `matrixcheck` only walks `packages/` for tests, so teach it to walk `scripts/` as well, and try it against a deliberate violation (a row with no test, a test citing an unknown row) before trusting it, as decision 97 did. Create `docs/release-notes.md` as the spec, with a row table (prefix `RN`), and cite the rows from test names.

Port Nova's cases, which are the catalog for this slice (its `main_test.go` titles are `RN01` to `RN20`, so you can read them for the exact behavior). Planned rows, to be renumbered into the spec:

- RN01 happy: the prompt carries both evidence blocks, the changelog section and the commit log, and the diffstat.
- RN02 happy: the body goes to stdout; with `--out` it goes to the file, and the byte count goes to stderr.
- RN03 happy: a body wrapped in a code fence is unwrapped; ANSI escapes are stripped; trailing spaces and runs of blank lines are cleaned.
- RN04 sad: the agent exits non-zero, so the body is the changelog section and the exit status is `3`.
- RN05 sad: empty output, oversized output (over `--max-bytes`), and output with no heading or bullet each fall back.
- RN06 sad: no changelog section and no usable agent output: no body, a message on stderr, exit `3`.
- RN07 sad: the agent times out, and the **whole process group** is killed, not only the agent (a tool can leave a child holding the output pipe). Use a fake clock or a very short `--timeout`, never a real wait of seconds.
- RN08 sad: `pi` is not installed (not on `PATH`): fall back, exit `3`.
- RN09 happy: a changelog section stops at the next `## ` heading, and the version in the heading is matched as `## [X.Y.Z]`.
- RN10 happy: a first release has no previous tag and the diff base is git's empty tree.
- RN11 happy: the version is separate from the range, so a rehearsal for an untagged version ends the range at `HEAD`.
- RN12 bad: usage errors (no refs, `from == to`, unknown flag) exit `2` with a message, and flags must come before refs.
- RN13 bad: a commit message or changelog line that tries to instruct the agent ("ignore the rules above") ends up as evidence data inside the prompt, below the rules, and the rules block is unchanged. Assert the rules are present and first, and that the hostile text appears only in the evidence section.
- RN14 happy: merge commits are excluded from the commit log; the commit body (the why) is kept.
- RN15 happy: the agent is started with exactly the pinned provider, model, thinking level and tools, and with no session, no extensions, no skills, no themes, no MCP and offline mode (check Nova's `RN10` for the flags).

The fake agent is a small executable script written to a temporary directory by the test and put first on `PATH` for the child. It prints what the test wants, exits with a chosen status, sleeps (using a very short real sleep only inside the child, which is the one place a test may wait for a process, and keep it to tens of milliseconds), or leaves a grandchild holding the pipe. Never call a real model from this suite.

`prompt.md` is Nova's with the wording changed for a library people install from npm: the reader is deciding whether to upgrade a dependency; upgrade notes first; `Added`, `Changed`, `Fixed`; at most 20 bullets; cite `(#NN)` only when the evidence names one; never invent a number, version, file or change; do not mention the model, the prompt or the process. Embed it by reading the file next to the script.

### Slice 2: the workflow

`.github/workflows/release.yml`, modeled on Nova's, with these differences. Read Nova's comments, because each explains a failure it hit.

- Triggers: `push` of tags `v*`, and `workflow_dispatch` with a `dry_run` boolean and an optional `tag`.
- Job `gate`: checkout, pnpm, Node from `.nvmrc`, `pnpm install --frozen-lockfile`, `pnpm run ci`. The same command as `ci.yml`.
- A check step before anything else in the release job: the tag minus `v` equals `packages/lyra/package.json`'s `version`, and `CHANGELOG.md` has a `## [X.Y.Z]` section. A dry run skips the tag check when the input names no real tag.
- Job `release` needs `gate`, with `contents: write` and `id-token: write` and nothing else, since it is the only job that may publish: build (`pnpm build`), publish with `npm publish --provenance --access public` run from `packages/lyra` (trusted publishing needs a recent npm: check `npm --version` in the runner and upgrade npm in a step if the docs require it), then the notes step, then `softprops/action-gh-release` with `body_path`. **Publish before creating the release** (`AGENTS.md`), and never publish on a dry run.
- Notes step: `continue-on-error: true`, `timeout-minutes: 15`, `OPENCODE_API_KEY: ${{ secrets.PI_REVIEW_API_KEY }}` set on this step only. Install Pi with `npm install -g @earendil-works/pi-coding-agent@1.5.2` in a `continue-on-error` step. Run the script, map exit status `3` to a warning, and write its `body.md` path to `$GITHUB_OUTPUT` only if the file is non-empty. Fetch full history (`fetch-depth: 0`), because the range needs every tag.
- Dry run: show the body in `$GITHUB_STEP_SUMMARY`, upload it as an artifact, and do not publish.
- Pin actions to the same major versions `ci.yml` uses.
- Top-level `permissions: contents: read`.

### Slice 3: docs and the procedure

Update `AGENTS.md` "Releasing" (the version bump, and that the workflow now exists), `docs/overview.md` and `docs/repository.md` where they say the workflow "does not exist yet", the "Where the work stands" paragraph, `CHANGELOG.md`, and `docs/decisions.md` with the TypeScript-script and version-bump calls (104 and 105 if nothing else has taken them).

## Cases to work through

- The tag does not match the package version. The changelog has no section for the tag. Two tags in one push. A tag on a commit that is not on `main` (the workflow cannot easily check this; note it as unfinished rather than guess).
- The agent prints a prompt-injection string. The agent prints a secret-shaped string: the body is published to a public page, so add a check that refuses a body containing a key-shaped string (`sk-`, `Bearer `, a long base64 run) and falls back. This is a sad case that should be a row.
- The key must never reach any step but the notes step: assert that by reading the workflow file in a test (a plain text check that `PI_REVIEW_API_KEY` appears exactly once), since a regression there is invisible otherwise.

## Docs to update

The ones in slice 3, plus the README status column and `notes.md`.
