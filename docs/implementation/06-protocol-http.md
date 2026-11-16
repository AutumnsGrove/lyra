---
title: "Step 6: the protocol over HTTP"
status: planning
category: features
---

# Step 6: the protocol, over HTTP

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-06-protocol-http`, from a `main` with steps 4 and 5 merged. Builds decisions 43 to 48 and 83 to 88 (the parts that exist without approvals), 90 (the line cap), 100, and the HTTP half of the protocol rows. After this step a client outside the process can start a task, watch it, steer it, stop it, and read its record, on Workers, with a record that outlives the object.

Read: `docs/protocol.md` in full (it owns this step, and its 28 pre-written rows are in `scripts/unbuilt-rows.json`), `docs/decisions.md` 43 to 48, 83 to 88, 90, 100, `docs/adapters.md`, step 2's runtime (`start`, `resume`, `wake`, `abort`, `steer`, `followUp`) and step 4's fixture Durable Object. Nova's protocol (`docs/PROTOCOL.md` in `~/Documents/Projects/nova`, read-only) is what "as in Nova" refers to for framing and bad-line handling, and Nova's protocol tests are what Lyra's port.

## Goal and done when

From `first-slice.md`: **a client can `start` a task, watch events, `abort` it, and `get_messages`. A small two-tool test task runs on Workers from `start` to done, with a record.** The original wording adds "through Lumen", which belongs to the Lattice half of step 5: here the model is the scripted one, or the OpenAI-style adapter if Autumn supplies a key. Done when:

- the commands below work over HTTP in workerd, with the responses and error codes of `protocol.md`;
- the record-derived events carry `seq`, and a client that reconnects with `Last-Event-ID` gets every missed event in order and no live-only events;
- every scenario file in `scenarios/` now runs a **second time**, over the real HTTP surface against the real fixture server in workerd (the first run is in-process, step 1);
- the frame reader, the command validator and the event projection have fuzz or property targets;
- `pnpm dev` starts a local server with real Durable Objects, alarms and SQLite, and `pnpm lyra start <task>` drives it;
- the rows listed under "Which rows" are tested and removed from `unbuilt-rows.json`.

## Out of scope, and what stays listed as unbuilt

Approvals, questions and proposals are a later slice (`first-slice.md`: "Approvals and proposals ... come after"). So `CMD08`, `CMD09`, `CMD10`, `EVT04`, `REQ01` to `REQ06` stay in `unbuilt-rows.json`. Edit that file's `step` text for `docs/protocol.md` to say so (the script reads only the row list), and say in the PR that this is deliberate. Also out: WebSocket and `hello` frames (step 8; over HTTP the version travels in a header), `compact` (step 7: answer `unsupported` until then), `list_sessions` (it needs an index across sessions, which is a design of its own, so answer `unsupported` and list it in the PR's Unfinished section), `list_pending` and `decide_proposal` (answer `unsupported`), image attachments, Heartwood sign-in.

## Which rows

Build and un-list: `CMD01` to `CMD07`, `CMD11` to `CMD13`, `EVT01` to `EVT03`, `EVT05`, `EVT06`, `FRM01`, `ACC01`, `ACC02`. Add rows as you write each piece, prefixes `FRM` (framing), `CMD`, `EVT`, `HTP`, `ACC`, as `protocol.md` says, and **add a new `CMD` row for each command it lacks one for** (`prompt`, `steer`, `get_state`). `EVT04` needs two clients answering one request, so it waits for approvals.

## Settled here

**Layering.** `src/protocol/` is part of the core entry point and is web-standard:
- `frames.ts`: the frame and command types, hand-written decoders, `encodeFrame`;
- `reader.ts`: a streaming line reader over `Uint8Array` chunks (split on `\n` only, `\r\n` accepted, empty lines skipped, a U+2028 inside a string is just text, UTF-8 decoded across chunk boundaries, a hard cap of **2 MiB** per line, `FRM01`: a line over the cap is a protocol error that closes the connection, as in Nova). It is the frame reader the catalog names as a fuzz target, and it is reused by step 8 and the dev client;
- `commands.ts`: validate a decoded command and return a typed command or `bad_request`/`unsupported` (a bad line is not fatal, an unknown command is `unsupported`);
- `events.ts`: the projection from record entries to events (below);
- `session.ts`: a protocol-agnostic `Session` that takes a command and returns a response, owns the runtime, and publishes events;
- `http.ts`: `createHttpHandler(sessionHost)`, a web-standard `(Request) => Promise<Response>`.
Nothing here imports Cloudflare. The Durable Object that hosts a session is in `adapters/cloudflare`.

**Commands implemented** (decision 83): `start`, `prompt`, `steer`, `follow_up`, `abort`, `resume`, `get_state`, `get_messages`. The others answer `unsupported` with a message naming the later slice. Behaviors:
- `start { task, input, session?, key? }` creates a session unless `session` is given, validates `input` against the recipe (`bad_request`), and answers `{ session, run }`. **Idempotency:** with a `key`, derive the Durable Object id from the tenant and key (`idFromName("<tenant>:<key>")`), so a repeated `start` lands on the same object, which compares task and input: same means return the existing run and start nothing (`CMD02`), different means `conflict` (`CMD03`). Without a key, use a fresh unique id. The session id the client sees is the Durable Object id string.
- `prompt { session, text }`: `busy` while a run is active unless `queue` is set (as in Nova), otherwise starts a run in the session.
- `follow_up`: queued during a run (`CMD04`); **when nothing is running it appends the message and starts the next run in the same session** (`CMD05`, decision 100). Step 2 deliberately did not build this, because it needs a session. A run that ended `done` is continued the same way as any other: same session, same record, a new `run_start`, and it ends in its own `run_end`.
- `abort` parks the run `stopped` (`CMD06`). `resume` continues a `stopped`, `limit`, `stuck` or `model_unavailable` park with a new `run_start` that names the run it continues (`CMD07`). Resuming a run waiting for a person is `busy`, but that is the approvals slice.
- `get_state { session? }`: run state, parked reason, usage so far, queue sizes (pending request count is zero until approvals).
- `get_messages { session, entry?, limit?, cursor? }`: the record's entries, or the branch ending at `entry` (`CMD11`; the record is a straight line, so the branch is the path to that entry), one page at a time with a cursor, so no reply exceeds the line cap (`CMD12`). Page size is capped.
- A command whose text is over the entry cap is `bad_request` and saves nothing (`CMD13`, decision 90), and so is a request body over the line cap.

**Events** (decisions 84, 86). The projection `eventsFor(entry, seq)` is a pure function from a record entry to zero or more events, each carrying `seq`, `ts`, `session`, `run`. Record-derived events: `run_start` (from the status that begins a run or segment), `message_end` and `usage` (from an assistant message), `tool_call` and `tool_end` (from the assistant message's calls and the tool messages), `turn_end`, `parked`, `resumed`, `fallback`, `run_end` (from a terminal status). Live-only events, **never replayed**: `retry`, `tool_start`, `tool_update`, `text_delta`. `run_end` has `reason` one of `done`, `parked`, `failed`, and `parked_reason` (`EVT01`: exactly one per run segment, none after it, from a record or a replay of it; `EVT02`: a limit gives `parked` with reason `limit` then `run_end`; `EVT03` a `fallback` event and a record entry; `EVT06`: a changed tool set gives `parked` with reason `stuck` and detail `recipe_changed`). Several events can come from one entry and share its `seq`, so a reconnect resumes from "after entry *n*", and the events of an entry are always delivered together.

**HTTP surface** (decision 45, `protocol.md`): `POST /v1/commands` takes one command and returns the response frame. `GET /v1/events?session=<id>` is a server-sent-event stream with `id:` set to the entry's `seq` on record-derived events, supporting `Last-Event-ID` (`EVT05`). `GET /v1/state?session=<id>` is `get_state`. `POST /v1/ui_response` exists and answers `unsupported` until approvals. The protocol version travels in the `x-lyra-version` header (a missing header means 1, anything else is `unsupported`). Responses are Nova's frame shape, `{ type: "response", id, command, ok, data }` or `{ ..., ok: false, error: { code, message } }`, with the HTTP status derived from the code (`bad_request` 400, `not_found` 404, `permission_denied` 403, `busy` and `conflict` 409, `unsupported` 501, `timeout` 504, `provider_error` 502, `internal` 500) so plain HTTP clients behave, while the body is always the frame. A client that stops reading is dropped when more than 1024 events queue for it, and it catches up on reconnect from the record, which is the improvement over Nova decision 86 describes. Live broadcast and replay must not interleave out of order: replay from the record first up to the current `seq`, then switch to live, with no gap and no duplicate (test this with events arriving during the replay).

**Access** (decisions 47, 87). Two doors: the public `fetch` handler requires `Authorization: Bearer <token>`, and the token determines the tenant; and a service-binding entry point (a `WorkerEntrypoint` class exposing a method that takes the tenant explicitly) that is reachable only through a service binding, so a trusted Grove worker names its tenant without a token. Verify against Cloudflare's docs that this is how a service binding to a named entrypoint works, and that the entry point is not reachable from the public `fetch` route. Tokens are configured as a secret mapping tenants to tokens (a JSON object read through the Secrets slot); compare in constant time, and never log or record a token. **Every session stores its tenant on its record's header, and every command is checked against it.** A command naming another tenant's session, or a session that does not exist, is `not_found` and never `permission_denied`, so session ids do not leak (`ACC01`). A request from outside with no token is refused (`ACC02`). A session's header gets a `tenant` field (the format already allows new fields).

**The run keeps going after the response.** `start` answers as soon as the run is accepted, and the loop continues in the object. Verify how a Durable Object behaves with a long-running background promise after its request ends (docs: when an object can be evicted while work is pending), and rely on step 4's alarm watchdog for the case where it is evicted anyway. The test that matters kills the object mid-run over the HTTP surface and watches the run finish.

**The dev client** is `scripts/lyra.mjs`, plain Node ESM with no dependencies, driving the HTTP surface: `pnpm lyra start <task> [--input file]`, `tail`, `steer`, `follow-up`, `abort`, `resume`, `messages`, with the base URL and token from the environment. It is a developer tool, not a coding TUI, and it reuses the built frame reader from `dist` rather than reimplementing it. **`pnpm dev`** runs `wrangler dev` against `examples/workers-minimal` (extended into a real small server with the two-tool test task). `AGENTS.md` already describes both commands as arriving here.

**Scenarios, second level.** Extend the scenario format: `steps: - send: { command: ... }` and `expect_events` / `expect_record` already exist, so the same files run over HTTP by translating `send` into `POST /v1/commands` and collecting the event stream. Files without `steps` run as `start` of their `recipe` with their `input`. A scenario must pass at both levels, and a failure message says which level.

## Slices

**Slice 1: frames, the reader, the validator.** `frames.ts`, `reader.ts`, `commands.ts`. Fuzz targets for the reader and the command validator; property test that `decode(encode(frame))` equals the frame. Rows: FRM01 to FRM08 (catalog "Protocol: framing": a line with `\r\n`, a U+2028 inside a string, a line at the cap and one over, two frames in one read, one frame across many reads, an empty line, invalid JSON, valid JSON of the wrong type, a missing `type`, an unknown `type`), including that a bad line yields a `bad_request` response and is not fatal, and an unknown command is `unsupported`.

**Slice 2: the event projection and replay.** `events.ts`. Property: projecting a record then replaying from any `seq` yields exactly the suffix; `run_end` appears once. Rows `EVT01`, `EVT02`, `EVT03`, `EVT06` here at the pure level, and `EVT05` after the HTTP layer.

**Slice 3: the session.** `session.ts` over the runtime, in-process with the memory adapter (no Cloudflare yet). The commands and their rows `CMD01` to `CMD07`, `CMD11` to `CMD13`, plus `prompt`, `steer`, `get_state`. Test with the testkit and a fake clock. Add the catalog's cases: two commands with the same `id`, a response for an unknown id, a client that disconnects mid-run (the run continues), `abort` while idle, a command while busy, a follow-up when nothing is running.

**Slice 4: the HTTP handler.** `http.ts`: routes, status mapping, the SSE stream with `Last-Event-ID`, backpressure, version header, body cap, auth. Rows (`HTP`, `ACC`): each route's happy, sad and bad; replay then live with no gap; a stalled reader is dropped and catches up; no token, wrong token, a session of another tenant (`ACC01`, `ACC02`).

**Slice 5: the Durable Object host and the Worker.** In `adapters/cloudflare`: the session object (replacing step 4's fixture double), the public `fetch` and the service-binding entry point, the idempotent session id, tenant stored on the header. Workerd tests drive it through `exports.default.fetch` (not a dynamic `import()`), including the kill-mid-run-over-HTTP test and the two-tool run from `start` to done.

**Slice 6: the scenarios, second level, and the dev client.** The `send` steps, the HTTP runner in the workers suite, `scripts/lyra.mjs`, `pnpm dev` and `pnpm lyra`, the extended example.

**Slice 7: wrap-up.** Remove the built rows from `unbuilt-rows.json` and update its `step` text, update `protocol.md` (the rows you added, the HTTP details settled here, a note on what is still unbuilt), `overview.md`, `adapters.md`, README status, `AGENTS.md` (the commands now exist), `CHANGELOG.md` (an upgrade note: there is now a wire), `decisions.md` (the status mapping, the id derivation, the two doors, 104 onward).

## Cases to work through from the catalog

All of "Protocol", including access (no token, wrong token, another tenant's session). "Cloudflare": an object evicted mid-run, now through the HTTP surface. "The loop": a follow-up while a run is active and after it ended. Untrusted data: every frame, header and body is hostile. Never reflect a token or a stack trace in a response, and never put tenant data in an error for the wrong tenant.

## Judgment calls already made

`list_sessions`, `list_pending`, `decide_proposal`, `compact` answer `unsupported` for now. The keyed session id is derived from tenant and key. HTTP statuses map from the error code, and the body is always a frame. The event queue cap per client is 1024. `x-lyra-version` is the version header. The dev client is a script, not a package.

## Mechanics changed in this step

`src/protocol/` is new in the core entry point (no new entry point, no new dependency). `adapters/cloudflare` grows the session object and entry point. `scripts/lyra.mjs` and the `dev` and `lyra` scripts are new, and `examples/workers-minimal` becomes a real server. `scripts/unbuilt-rows.json` shrinks and its note changes. Watch the size budget and the example's bundle ceiling.
