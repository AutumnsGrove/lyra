---
title: "Step 8: WebSocket"
status: planning
category: features
---

# Step 8: WebSocket

Last updated: 2026-11-16. Read [`README.md`](README.md) first. Branch: `feat/step-08-websocket`, from a `main` with step 7 merged. Builds decision 45's second transport, decisions 85 and 86 for WebSocket, and decision 101's WebSocket caveat. It adds nothing to what Lyra can do. It lets the same client work over a second wire, with live stop and steer on one connection and a socket that can sleep while a run is parked.

Read: `docs/protocol.md` ("Wire", "Replay from the record", and the hibernation paragraph under it, which was checked against Cloudflare's API on 2026-11-16), `docs/decisions.md` 101, step 6's `reader.ts`, `session.ts`, `http.ts` and the session Durable Object, and the dev client.

Verify against Cloudflare's current docs, because this API moves: `ctx.acceptWebSocket(server)` (not `server.accept()`) is what allows hibernation; messages arrive at `webSocketMessage(ws, message)`, closes at `webSocketClose`, errors at `webSocketError`; per-connection state goes in `serializeAttachment` and comes back from `deserializeAttachment`, capped at 16,384 bytes; the connection stays open to the client while the object is out of memory; **a scheduled alarm prevents hibernation**, so a run parked with a wake time keeps the object awake until the alarm fires, which affects billing, so say so in the PR.

## Goal and done when

From `first-slice.md`: **the same client works over both.**

- `GET /v1/ws?session=<id>` upgrades to a WebSocket that carries the same frames in both directions: commands from the client, `response` and `event` frames from the server;
- a reconnect with `since=<seq>` replays every missed record-derived event from the record, in order, with no live-only events, then continues live, with no gap and no duplicate;
- a connection survives an object eviction (hibernation) and works on the next frame;
- every scenario file now runs a **third** time, over WebSocket;
- the dev client works over either transport with `--transport http|ws`.

## Out of scope

Approvals over WebSocket (`ui_request` and `ui_response` frames wait for the approvals slice, but build the frame types' decoders now only if step 6 did not), browser clients, compression, multiple sessions on one socket.

## Settled here

**Connection shape.** One socket is one session, named in the query string: `session=<id>` and optional `since=<seq>`, mirroring HTTP's `Last-Event-ID`. This keeps the hibernation attachment small (a session id, the last `seq` sent, the tenant) and avoids a subscribe protocol that the decisions do not call for. Record the choice in `protocol.md` as an addition to the `hello` description, because `protocol.md` says the version and tenant travel in `hello`: **the server sends `hello` first** (`{ type: "hello", version: 1, server, capabilities }`), the client answers with its `hello` (`{ type, version: 1, client, capabilities, tenant? }`), and no command is accepted before the exchange (a command first is `bad_request`, the socket stays open). A trusted caller's `tenant` is honored only through the service-binding door; on the public door the tenant comes from the bearer token in the upgrade request, and a `tenant` in `hello` from a token caller is ignored.

**Framing** is step 6's reader: UTF-8 JSON, one object per frame, a frame at the 2 MiB cap is accepted and one byte over closes the connection with a protocol error (`FRM01`). WebSocket messages already delimit frames, so decode each message as one frame, and also accept several newline-separated frames in one message and a frame split across messages only if Nova's behavior does (read its `PROTOCOL.md`); if not, say it is not supported and test the refusal.

**Hibernation.** Use `ctx.acceptWebSocket`, handle `webSocketMessage`, `webSocketClose`, `webSocketError`, and keep nothing in memory that a hibernated object cannot rebuild. On each message after wake-up, rebuild the session from storage, read the attachment, and carry on. The live event fan-out is rebuilt from `ctx.getWebSockets()` rather than a set held in memory, since the set is gone after an eviction.

**Replay then live.** On connect, replay from `since` up to the current `seq` from the record, then deliver live events, with no gap and no duplicate. Reuse step 6's mechanism, and share one implementation between SSE and WebSocket instead of copying it. The last `seq` delivered is kept in the attachment so a wake-up after hibernation does not resend.

**A client that stops reading.** WebSocket sends can back up. If the outgoing buffer passes a limit (default 1 MiB queued, configurable), close the socket with a policy code, and let the client reconnect and catch up from the record. Nothing is lost, because live-only events are not promised.

**Close codes.** Normal close 1000, protocol error 1002 (a bad frame size or a command before `hello`), policy violation 1008 (a backed-up reader, an unauthorized upgrade is refused with HTTP 401 before the upgrade instead), internal 1011. Pick these, write them in `protocol.md`.

**Access.** The upgrade request is authenticated exactly like an HTTP request: bearer token or the service-binding door. An upgrade for another tenant's session is refused with the same `not_found` that HTTP gives.

## Test layout, and the isolation issue

Decision 101: **WebSockets with Durable Objects are unsupported under per-file storage isolation**, so WebSocket test files run with `--max-workers=1 --no-isolate`, and share storage within those files. Put them in their own files (`*.ws.workers.test.ts`) and their own Vitest project or config, so the rest of the workers suite keeps isolation. Because storage is shared in those files, every test must use a fresh session id and must not assume an empty record. Say in `notes.md` how you did it. If the `--no-isolate` suite is flaky, record the flake rate and stop and tell Autumn rather than retrying until green.

## Slices

**Slice 1: the upgrade, `hello`, and commands over a socket.** The route, the handshake, `webSocketMessage` dispatching to step 6's `Session`. Rows (prefix `WSK`, in `protocol.md`): WSK01 upgrade then `hello` exchange; WSK02 a command before `hello` is `bad_request` and the socket stays open; WSK03 each implemented command works over the socket with the same response as HTTP; WSK04 an upgrade without a token, or for another tenant's session, is refused; WSK05 a frame over the cap closes with 1002; WSK06 invalid JSON, wrong type, unknown `type` are non-fatal responses (as HTTP).

**Slice 2: events, replay, reconnect.** Fan-out, replay from `since`, the shared implementation with SSE. Rows: WSK07 events arrive live in order; WSK08 reconnect with `since` gets every missed record-derived event and none live-only (the `EVT05` behavior again); WSK09 events produced during the replay are neither lost nor duplicated; WSK10 two sockets on one session both receive events; WSK11 a client that disconnects mid-run does not stop the run.

**Slice 3: hibernation and backpressure.** Evict the object while a socket is open and a run is parked, then send a frame and see it work; the attachment carries session, tenant and last `seq`; a backed-up reader is closed with 1008 and catches up on reconnect. Rows: WSK12 eviction while parked, then a command works; WSK13 eviction mid-run with an alarm, the socket gets the rest of the events after the run resumes; WSK14 attachment contents survive and stay under the 16,384-byte cap (assert the size); WSK15 a slow reader is dropped, then catches up; WSK16 an alarm keeps the object awake (document, do not assert billing).

**Slice 4: the third level and the dev client.** The scenario runner over WebSocket, in the `--no-isolate` project; `scripts/lyra.mjs --transport ws`. The same scenario files must pass in-process, over HTTP, and over WebSocket, and a failure message names the level.

**Slice 5: wrap-up.** `protocol.md` (rows, the query-string and `hello` details, close codes, the hibernation and alarm note), `engineering-practices.md` (the isolation setup), `overview.md`, README status, `AGENTS.md` (test commands), `CHANGELOG.md`, `decisions.md` (104 onward). Remove from `unbuilt-rows.json` anything this step built (probably nothing, since the WebSocket rows are new).

## Cases to work through from the catalog

"Protocol": framing edge cases over a socket, a client that disconnects mid-run, a client that stops reading, a command while busy, access. "Cloudflare": an object evicted at each point, an alarm that fires while a socket is open. Untrusted data: a hostile frame over a socket must never reach the session unvalidated, and an error frame must not echo the frame back at full length.

## Judgment calls already made

One session per socket, selected by query string. The server speaks `hello` first. 1 MiB outgoing backlog. Close codes as listed. Shared replay code with SSE. WebSocket tests in a separate non-isolated project.

## Mechanics changed in this step

A second workers Vitest project or config with `--max-workers=1 --no-isolate`, added to `pnpm test:workers` or beside it and to `ci`. No new dependency. `protocol.md` gains its `WSK` rows.
