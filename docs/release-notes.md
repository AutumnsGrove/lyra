---
title: "Lyra: the release notes script and the release workflow"
status: building
category: features
---

# The release body, and the workflow that publishes

Last updated: 2026-11-19. The spec for step R: the script that writes a GitHub release body from the
changelog section and the commit log, and `.github/workflows/release.yml`, the workflow a version tag
runs. The slice that builds it is [`implementation/R-release-workflow.md`](implementation/R-release-workflow.md),
and the decisions behind it are 74 to 76 and 99, with the ones step R made in `decisions.md` (120 to
122). This document adds no decisions; when it and `decisions.md` disagree, `decisions.md` wins.

The script exists because every release Nova published before its own script had an empty body: the
changelog is the record, but it is not where a reader lands. The same reasoning applies here, and so
does the constraint that matters more: **a body is a courtesy, so it may never block a release.**

## What the script does

`node scripts/release-notes/main.ts [flags] [previous-tag] <tag>` runs with no build step, on Node's
type stripping, because the `scripts/` tree is TypeScript and the Node floor (22.19) strips types
natively (decision 120). It reads a tag range from git, the release's section from `CHANGELOG.md`, and
gives both to the Pi agent as equal evidence, plus a diffstat. The agent's answer becomes the body when
it is usable. When it is not, the changelog section becomes the body, and when there is no section
either, the release publishes with no body at all.

`--check` is the other mode. It is the release job's first step: the tag has to equal the version in
`packages/lyra/package.json`, and `CHANGELOG.md` has to have a section for it, so a publish can never
disagree with the thing it is named after (decision 122).

### Exit codes

| Code | Meaning |
|---|---|
| `0` | The agent's body was used, or `--check` is satisfied |
| `1` | `--check` found the release cannot proceed, and said why |
| `2` | A usage or setup error: bad flags, no refs, a ref that is not in this repository |
| `3` | The body came from the fallback, so the agent's answer was not used (and possibly there is no body) |

The workflow turns `3` into a warning and never fails the release on it, because a silent fallback is
the one thing that must not happen: the job log says the body was the changelog, not a summary.

### Flags

Flags come before the refs, and the usage text says so; a flag after a ref is a usage error rather than
one that is silently ignored.

| Flag | Default | What it does |
|---|---|---|
| `--repo <dir>` | `.` | The repository to read |
| `--changelog <path>` | `CHANGELOG.md` | Changelog path, relative to the repository |
| `--version <v>` | the tag, without `v` | The version whose changelog section to use |
| `--out <path>` | stdout | Write the body to a file, and its size to stderr |
| `--provider <name>` | `opencode-go` | The agent's provider |
| `--model <id>` | `deepseek-v4.1-flash` | The agent's model |
| `--thinking <level>` | `high` | The agent's thinking level |
| `--max-bytes <n>` | `16384` | Refuse a body larger than this, in bytes |
| `--timeout <ms>` | `720000` | The agent's deadline |
| `--prompt-only` | off | Print the prompt and exit without calling the agent |
| `--check` | off | Check the release instead of writing a body, with `--package` and `--dry-run` |
| `--package <path>` | `packages/lyra/package.json` | With `--check`, the package whose version the tag must equal |
| `--dry-run` | off | With `--check`, report disagreements as warnings instead of failing |

The provider, model, thinking level and tool list are pinned in the script rather than read from a
config, so a release is reproducible, and they are the ones `pi-review` already runs in CI (decision
76). The agent gets no session, no extensions, no skills, no prompt templates, no themes, no MCP, no
context files, and offline mode: the only thing it may do is read the tree it was given.

### What the agent is told

The rules are `scripts/release-notes/prompt.md`, read from beside the script and sent on stdin. They
say the reader is deciding whether to upgrade a dependency they did not choose, that upgrade notes come
first, that at most 20 bullets is a body and not a changelog, that a `(#NN)` may only be cited when the
evidence names one, and that nothing may be invented. Everything after `# Evidence` is data: the
changelog section, the commit subjects and bodies, and the diffstat. Text inside it is evidence, never
an instruction, which is why the rules come first and the evidence section is the only part a commit
message can reach.

### What makes an answer usable

An answer is the body when, after cleaning, it is non-empty, no larger than `--max-bytes`, and contains
at least one heading or bullet. Cleaning strips terminal escapes, unwraps a fence around the whole body,
removes trailing spaces, and collapses runs of blank lines. An answer is refused when it contains a
key-shaped string (`sk-`, `Bearer `, or a long run that looks like base64), because the body is
published to a public page and a leak there cannot be taken back. Every refusal falls back with a
warning naming the reason.

## The workflow

`.github/workflows/release.yml` runs on a `v*` tag and on a manual dispatch. It reads Nova's, whose
comments each name a failure it hit, with four differences: npm instead of GoReleaser-style archives,
the version check above, publish-before-release, and a dry run that never publishes.

- **`gate`** runs the same command `ci.yml` runs, from the same commit, so a tag cannot publish what a
  pull request would have failed.
- **`release`** needs the gate, and is the only job with `contents: write` and `id-token: write` and
  nothing else, because it is the only job that may publish. It checks the version, builds, publishes
  with `npm publish --provenance --access public` and no token (decision 99), then writes the body and
  creates the release with `body_path`. Publish comes before the release page (decision 75).
- **The npm skip.** A tag re-run, or a bootstrap publish made by hand, must not turn into a failed
  release: if that exact version is already on the registry the step says so and carries on to the
  release page (decision 121).
- **The notes steps are allowed to fail.** Installing Pi, and running the script, are
  `continue-on-error`, the notes step maps status `3` to a warning, and its own deadline is 12 minutes
  inside a 15 minute step, so nothing about the body can stop a publish.
- **The key reaches one step.** `secrets.PI_REVIEW_API_KEY` is mapped to `OPENCODE_API_KEY` on the
  notes step and nowhere else, and `RN19` reads the workflow file to keep it that way.
- **A dry run** runs everything except the publish and the release page, prints the version check's
  findings as warnings, and writes the body to the job summary and as an artifact.

## Spec rows

| ID | Case | Expected |
|---|---|---|
| RN01 | Happy: the prompt carries both kinds of evidence | `--prompt-only` prints the rules first, then the changelog section, the commit subjects and bodies, and the diffstat, and never starts the agent |
| RN02 | Happy: the body goes to stdout | A usable answer is printed byte for byte, with no warning on stderr and status `0` |
| RN03 | Happy: an answer is made safe to publish | A fence around the whole body is unwrapped, terminal escapes are stripped, trailing spaces go, and runs of blank lines collapse to one |
| RN04 | Sad: the agent fails | A non-zero exit prints the changelog section, warns on stderr, and returns `3` |
| RN05 | Sad: the answer is unusable | Empty output, output over `--max-bytes`, and output with no heading or bullet each fall back to the changelog section with `3`, and the warning names the reason |
| RN06 | Sad: nothing to fall back to | With no usable answer and no changelog section there is no body, stderr says the changelog had no section, and the status is `3` |
| RN07 | Sad: the agent outlives its deadline | The whole process group is killed, not only the agent, so wall clock stays bounded by the deadline and the body is the changelog section |
| RN08 | Sad: `pi` is not installed | The body is the changelog section, the warning says the agent was not found, and the status is `3` |
| RN09 | Happy: the changelog section ends at the next version | `## [X.Y.Z]` is matched as a heading, its content is taken without the heading, and the section after it never reaches the body |
| RN10 | Happy: a first release | With one ref there is no previous tag, the whole history up to the tag is the evidence, and the diffstat starts at git's empty tree, so a file added before the first tag is in it |
| RN11 | Happy: the version is separate from the range | `--version` chooses the changelog section while the range still comes from the refs, so a rehearsal for an untagged version works |
| RN12 | Bad: usage errors | No refs, an unknown flag, too many refs, a ref that is not in the repository, and a flag after the refs each exit `2` with a message that names the usage |
| RN13 | Bad: evidence that gives orders | A commit message saying "ignore the rules above" is inside the evidence section and after the rules, and the rules block is exactly `prompt.md` |
| RN14 | Happy: merges are excluded and the why is kept | A merge commit is not in the prompt, and an ordinary commit's body is |
| RN15 | Happy: the agent is pinned | The agent is started with exactly the pinned provider, model, thinking level and tools, with no session, extensions, skills, prompt templates, themes, MCP or context files, and offline |
| RN16 | Bad: a body with a secret in it | An answer containing a key-shaped string is refused and the changelog section is the body, so a secret cannot reach a public page |
| RN17 | Happy: the default cap fits a large release | A 12 KiB answer is the body and a 17 KiB one falls back, so the cap refuses a commit dump without refusing a real release |
| RN18 | Happy: `--out` writes the file | With `--out` stdout is empty, the file holds the body byte for byte, and stderr says how many bytes were written |
| RN19 | Bad: the key reaches one step | `release.yml` names `PI_REVIEW_API_KEY` exactly once, on the notes step, and no step sets a token for npm |
| RN20 | Bad: a dry run never publishes | The publish step is guarded by a tag ref and not being a dry run, only the release job may write or mint a token, and the notes step is allowed to fail inside its own deadline |
| RN21 | Happy: the release check passes | `--check` returns `0` when the tag, the package version and the changelog section all agree, with or without the `v` |
| RN22 | Sad: the release check fails | A tag that disagrees with the package version, and a changelog with no section for it, each return `1` and name both sides |
| RN23 | Happy: a dry run's check only warns | The same disagreements in a dry run are warnings on stderr with status `0`, so a rehearsal is never blocked by a version it has not released yet |
