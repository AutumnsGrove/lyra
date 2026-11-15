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

### Changed

- Prettier checks the code and the configuration, but not `docs/`, so the planning record stays as it
  was written, and not `.github/pi-review.json`, which pi-review generates with its own serializer
  (decision 95).
