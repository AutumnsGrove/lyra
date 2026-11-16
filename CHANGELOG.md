# Changelog

All notable changes to Lyra are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While Lyra is `0.x`, a minor bump carries
new API and any breaking change, and a patch bump is fixes only.

## [Unreleased]

### Added

- The planning record, moved from Lattice: the overview, the decisions, and one document per topic
  in `docs/`, with the raw research in `docs/research/`.
- `AGENTS.md`, the instructions for people and agents working here, from the draft in
  `docs/agents-guide.md`, plus a `CLAUDE.md` that points at it.
- The gate: `pnpm run ci` runs format, typecheck, build, test, fuzz, import checks, the matrix
  check, size budgets, and coverage, and `.github/workflows/ci.yml` runs the same command on every
  pull request and on `main`.
- The three check scripts the gate needs, each tried against a deliberate violation before it was
  trusted: `scripts/importcheck.mjs` (entry-point imports, web-standard core, no Lattice),
  `scripts/matrixcheck.mjs` (the matrix rule), and `scripts/budget.mjs` (gzipped size).
- `scripts/unbuilt-rows.json`, which lists the 37 spec rows written during planning that have no code
  yet, with the step that builds each area (decision 96).
- The published package `@autumnsgrove/lyra` at `0.0.0`: TypeScript strict, built to `dist`, with
  only the core entry point until an adapter needs another (decisions 69, 95).

- `docs/implementation/`: the shared rules for building (branches, commits, one pull request per
  step with `pi-review` addressed, when to stop and ask) and one document per step, R and 1 to 8,
  plus briefs for the three steps that live in Lattice. They add no decisions.

### Changed

- The planning record carries no open questions, and it gained decisions 99 to 103 in the process. The
  two the first slice listed, the repository's name, layout and release process, and whether the
  Cloudflare adapter builds on Cloudflare's agent tooling, were already decided (68 to 73, 95, 98), so
  the `## Open` sections in `first-slice.md`, `adapters.md`, `consumers.md` and `repository.md` now say
  so instead of reopening them; what stays open on purpose is decision 103.
- Releases publish over OIDC with npm trusted publishing and `--provenance`, holding no token in the
  repository (decision 99). A `follow_up` that arrives when nothing is running continues the
  conversation in the same session (decision 100). The Cloudflare test tooling is named rather than
  flagged: `@cloudflare/vitest-plugin`, renamed from `@cloudflare/vitest-pool-workers`, running on
  Miniflare and therefore workerd, with four documented issues that shape that suite (decision 101).
  The 2 MB Durable Object row limit is confirmed against the live page, which disagrees with its own
  markdown copies (decision 102).
- Prettier checks the code and the configuration, but not `docs/`, so the planning record stays as it
  was written, and not `.github/pi-review.json`, which pi-review generates with its own serializer
  (decision 95).
