---
title: "Step 5 (Lyra half): the OpenAI-style model adapter, the fake model server, cassettes, and live tests"
status: planning
category: features
---

# Step 5, the Lyra half: models

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-05-openai-adapter`, from a `main` with step 3 merged (it does not need step 4, so it can run before or after it if Autumn wants). Builds decisions 14, 15, 26 (the slot's retry signals), 64, 65 and 66. The **Lumen half** of step 5 is Lattice work and is in [`lattice-briefs.md`](lattice-briefs.md).

Read: `docs/adapters.md` ("Model connections"), `docs/engineering-practices.md` (catalog "Model and streaming", "Local testing, before it ships", "OpenCode Go for live testing", "Recording real responses"), `docs/decisions.md` 14, 15, 64, 65, `docs/research/nova-notes.md` (how Nova handled both providers; the code is Go, only the shape carries over), and step 1's `ModelSlot`, `decode-reply` and the scripted model.

## Goal and done when

**The Lyra half is done** (PR #17 and #18, `a74cbd4` and `a7b4d8c`): the entry point exists, the fake
server drives every catalog case, the seeded model drives whole runs, cassettes replay in CI and the
scan refuses a key-shaped string, and `pnpm test:live` made a real call with a tool through both
providers on 2026-11-21. The Lumen half below is still Lattice work.


From `first-slice.md`: **one real call with a tool goes through each provider.** The agent cannot do the live half (it has no keys, and live calls spend Autumn's allowance), so this step is done when:

- `@autumnsgrove/lyra/openai` exists: a `ModelSlot` that speaks chat completions with streaming, usable against OpenRouter and OpenCode Go by configuration;
- a fake model server, in the testkit, serves the same scripts as real server-sent-event bytes and can misbehave on purpose, and the adapter passes every catalog case against it;
- a seeded random misbehaving model drives whole runs and every run ends with exactly one `run_end` and a record that loads (decision 64);
- cassettes can be replayed in CI, a test fails if a cassette holds a key-shaped string, and the recorder exists;
- `pnpm test:live` exists, is opt-in, has a hard budget cap per test, and **has been run by Autumn** (or is listed under Unfinished with the exact command, saying it needs her keys). Never invent a live result.

## Out of scope

The Lumen adapter and the mock Lumens (Lattice). Other dialects (OpenAI Responses, Anthropic Messages): decision 14 says chat completions only, and a model that needs another is not used yet. Streaming deltas to clients (step 6 and later; the adapter may accept an optional delta callback, but nothing consumes it yet). Image input.

## Verify these before relying on them

These were read from Nova's notes and the planning docs, not from the providers' live documentation. Check each against current docs (`context7` or the sites) and write the answer in `notes.md`. Do not paste a key anywhere to find out.

- OpenRouter: base URL `https://openrouter.ai/api/v1`, key in `OPENROUTER_API_KEY`, chat completions at `/chat/completions`, tool calls and `tool_choice`, `finish_reason` values, how to ask for token usage in a stream, and whether and how it reports cost (it has a usage-accounting option; if it returns a cost, the usage `source` is `provider`).
- OpenCode Go: base URL `https://opencode.ai/zen/go/v1`, key in `OPENCODE_GO_API_KEY`, models list at `/models`, a session header `x-opencode-session`, and **which models speak chat completions** (decision 14: only those are used). Cost is an allowance, not dollars, so usage carries tokens only unless the response says otherwise, and if it does the source is `allowance`.
- Per model: which `tool_choice` values are accepted (some accept only `auto`) and whether a repeated prefix is cached automatically or needs a marker (`adapters.md`). Hold this in a small per-model table inside the adapter. **The core never sends an option a model might reject.**

## Settled here

**The adapter** is `createOpenAIChatModel({ baseUrl, model, secrets, keyName, headers?, fetch?, clock, quirks? })`. The key comes from the `SecretsSlot` by name, never from a parameter, so it never sits in a config object that could be logged or recorded. `fetch` is injectable (default `globalThis.fetch`), which is how both the fake server and cassettes plug in. Provider presets, `openRouter()` and `openCodeGo()`, are thin: a base URL, a key name, headers, and the quirks table.

**Streaming into a whole reply.** The slot returns whole replies (step 1). The adapter requests `stream: true`, parses server-sent events with a pure function, and assembles text, reasoning (when the provider sends it), tool calls, usage, finish reason, and model into one `ModelReply`. The parser is the single most hostile-input surface in the repository, so it is a fuzz target. It handles, per the catalog: a stream that ends with no final marker; one that ends mid-event; a chunk with empty `choices` (usage only); a chunk with `null` content; a tool call split across many chunks, with the name first, arguments in fragments, and the id arriving late; two tool calls interleaved by `index`; a tool call with no id (assign a stable synthetic one, `call_<n>`, and record that you did); duplicate ids; usage in the last chunk, in a separate chunk, or missing; unknown extra fields everywhere (ignored); a `data: [DONE]` marker; comment lines and `\r\n`; and a single chunk that is huge (cap the total assembled size and fail with `provider_error` past it, rather than exhausting memory). The assembled reply goes through step 1's `decode-reply` before it leaves the adapter, so what the loop receives has been validated at the boundary.

**Finish reasons** map to the core's: `stop`, `length`, `tool_calls`, `content_filter`, anything else or missing becomes `other`. **A reply cut off by the token limit while holding tool calls must be reported as `length` with its calls**, because the loop must see it to refuse to run them (decision 25). A stream cut off by the network is **not** a `length` reply: it is a retryable error, and the partial reply is discarded.

**Errors become `ModelError` with the right `retryable` flag**, because step 2's retry logic trusts it. 401, 403, 404, 400: not retryable (a 400 saying the context is too long is its own code, so step 7 can use it). 408, 429, 500, 502, 503, 504: retryable, and a `Retry-After` header (seconds or an HTTP date) becomes `retryAfterMs`, with a sane cap. A **200 response whose body is an error object** is an error. A non-JSON error body is an error whose message is truncated and never echoes a request header. Connection refused and reset mid-stream (a `fetch` that rejects or a body stream that errors) are retryable. A stall: the adapter takes a deadline and uses the injected clock to enforce it, aborting the request, as a retryable `timeout`. Cancellation (the request's `AbortSignal`) at each of: before the request, during connect, mid-stream, after the last chunk, ends the call quietly with an abort error that the loop treats as a stop, never as a failure to retry. An `Authorization` header and the key never appear in an error message, a log, or a record.

**Usage and cost** (decision 15): tokens are always reported (zero when the provider omits them, never a crash), cost only when the provider gave one, with `source` set accordingly.

**The fake model server** lives in the testkit and is **web-standard**: a function `(Request) => Promise<Response>` that serves a script as real SSE bytes, passed to the adapter as its `fetch`. It cannot open a socket, because `importcheck` bans `node:*` everywhere under `src/`, and a socket would add nothing the injected `fetch` does not already prove, except genuine TCP failures, which are simulated by a `fetch` that rejects with a `TypeError` (what the platform does) and by response bodies that error mid-stream. Record this tradeoff in `notes.md`. It misbehaves on request: cut the stream mid-event, send malformed JSON in a `data:` line, stall (on the fake clock), return 429 with and without `Retry-After`, return 500, return a 200 with an error body, return a non-JSON error, and send one very large chunk. The same scripts that drive the in-process scripted model drive this, so one scenario can run through either.

**The random misbehaving model.** A seeded generator produces valid-looking but wrong replies: truncated JSON, wrong tool names, repeated calls, an empty reply, a `length` finish with calls, usage missing. A run against it must always end in exactly one `run_end` with a record that loads. The seed prints on failure.

**Cassettes** (decision 65). A cassette is a JSON file of recorded request and response pairs with **auth headers and key-shaped strings removed at record time**. Replay is a `fetch` built from the cassette, web-standard, so CI replays with no network. A test scans every file in `cassettes/` and fails on a key-shaped string (`sk-` followed by a long token, `Bearer` followed by a long token, a long base64 or hex run, the exact value of any environment variable whose name ends in `_API_KEY` if one is set). Write that test so it **can fail**: run it once against a cassette you deliberately contaminate, and show that it fails. The first cassettes cannot be recorded without keys, so hand-build one or two from the fake server's output to exercise the machinery, mark them in a `_note` field as synthetic, and say in the PR that real recordings are waiting on `pnpm test:live`.

**Live tests and the recorder live outside `src/`,** in `packages/lyra/live/`, because they need `node:fs`, the environment and the network. They are never published, never in the gate, excluded from the build, from coverage, and from the default Vitest run, and have their own config and script (`pnpm test:live`). Each live test sets Lyra's own limits as a **budget cap** (a small step limit, a token limit, and a time limit), so a bad loop cannot burn an allowance (`AGENTS.md`). A test skips, loudly, when its key is missing, and never prints it. OpenCode Go is the default for bulk testing, and avoid the heavy suites during the UTC hours when some models cost double (the catalog in Nova's notes). OpenRouter covers a small production-fidelity set. A flag records the exchange as a cassette. Add `live/` to `tsconfig.json`'s typecheck (it may use Node types there only, via its own tsconfig) and keep it out of `tsconfig.build.json`. `matrixcheck` scans `packages/` for tests, so the live tests will be scanned: they cite no rows, which is fine.

## Slices

Built in two pull requests on one branch (Autumn's call, 2026-11-19): **PR A is slices 1 to 3**,
which is the adapter and the fake server it is tested against, and **PR B is slices 4 to 7**, which is
the seeded misbehaving model, cassettes, the live suite and the wrap-up. The slices below are marked
with where they landed.

**Slice 1 (PR A): the entry point and the SSE parser.** `adapters/openai/` row in `importcheck` (may import the core and `fetch` only), the exports map, and `sse.ts`, a pure parser with its fuzz target. Rows (prefix `OAI`, in `adapters.md`): OAI01 a plain text stream assembles; OAI02 a tool call split across chunks with the id late assembles; OAI03 two interleaved calls; OAI04 usage in the last chunk, separately, and missing; OAI05 empty `choices` and `null` content chunks; OAI06 no final marker and a cut mid-event are errors that discard the partial reply; OAI07 a tool call with no id gets a synthetic stable one; OAI08 duplicate ids; OAI09 unknown fields ignored; OAI10 `\r\n`, comment lines, `[DONE]`; OAI11 a huge chunk is capped. Fuzz: hostile bytes never throw, never loop, never return an unbounded reply.

**Slice 2 (PR A): request building.** Messages (system, user, assistant with tool calls, tool results) to the wire format; tools; `tool_choice` only when the model accepts it; the quirks table; headers including the session header. Rows: request shape for each message kind; a tool turn round trips (the call id on the result matches); an option the model rejects is never sent; no key in any request body or logged form.

**Slice 3 (PR A): the fake model server and errors.** The testkit server and its misbehaviors, and the adapter's error mapping. Rows: one per HTTP status in the catalog, retryable or not, `Retry-After` as seconds and as a date and absurdly large, a 200 error body, a non-JSON error body, connection refused and reset, a stall past the deadline on the fake clock, cancellation at each of the four points, and **an end-to-end row through step 2's retry logic**: a 429 then success completes the run, and four 500s park it as `model_unavailable`. Add KIT rows for the server itself ("with its own strict tests").

**Slice 4 (PR B): the misbehaving model and the in-process/over-fetch scenarios.** Built. The seeded generator, the whole-run property, and the scenario runner learning to drive a scenario through the fake server as well as the scripted model (`model:` is the same script either way). Rows: the property; a scenario that passes both ways.

**Slice 5 (PR B): cassettes.** Built, with the recorder in `live/`. Recorder (in `live/`), replay, the secret scan, the synthetic cassettes. Rows: replay reproduces a recorded run; the scan fails on a contaminated cassette; a request that does not match any recorded exchange fails the test clearly instead of calling the network.

**Slice 6 (PR B): live tests and presets.** Built; not run, for want of keys. `openRouter()`, `openCodeGo()`, the live suite with budget caps, `pnpm test:live`, and a short `live/README.md` stating how to run it, which env vars it reads, and what it costs. **Do not run it.** If Autumn has put keys in the environment and asked you to, run it, report exactly what it did, and never print a key or an `Authorization` header.

**Slice 7 (PR B): wrap-up.** Done. `adapters.md` (rows, the verified facts, the quirks table's contents), `overview.md`, `engineering-practices.md` (the fake server as built, the tradeoff), `decisions.md` (the provider facts you verified, the web-standard server, cassette format, 104 onward), README status, `AGENTS.md`, `CHANGELOG.md`.

## Cases to work through from the catalog

All of "Model and streaming" lands here, and the stream-shaped ones land in the parser. "Cancelled before the request, during connect, mid-stream, after the last chunk." "Finish reasons: `stop`, `length`, `tool_calls`, `content_filter`, unknown, missing. A reply cut off by the token limit while holding tool calls must never run them." Confirm that last one end to end: a fake-server stream that ends on `length` with a tool call produces a run in which the tool did not execute. Untrusted data: model output is untrusted (tool names, arguments, text): nothing the adapter parses may reach a shell, a path, or an eval.

## Judgment calls already made

The fake server is a `fetch`, not a socket. Synthetic ids are `call_<n>`. A reply over a total size cap is `provider_error`. Live tests and the recorder live in `packages/lyra/live/`. The key is only ever read through the Secrets slot. Quirks are a plain table in the adapter.

## Mechanics changed in this step

`importcheck` (an `openai` row), `exports`, a live Vitest config and script, `tsconfig` for `live/`, a `cassettes/` directory (at the repository root, next to `scenarios/`), the testkit grows. No runtime dependency: `fetch`, `ReadableStream`, `TextDecoder`, `AbortSignal` are all web-standard. Re-check the size budget.
