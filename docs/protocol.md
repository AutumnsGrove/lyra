---
title: "Lyra protocol"
status: planning
category: features
---

# The protocol

Last updated: 2026-11-15. Decisions 43 to 48 and 83 to 88 are decided.

## What it is

The protocol is how anything outside Lyra talks to it: an Arbor page, a script, another worker, a terminal. It answers four things. How do I start a run? How do I stop it, steer it, or add a follow-up? How do I answer an approval? How do I watch what is happening and read the record?

## Decided

**43. Lyra speaks Nova's frames.** A subset of them, plus a few new ones. One client could drive either. This was a goal of the original issue. Nova's protocol (`docs/PROTOCOL.md` in the Nova repository) is JSON, one object per line, and every connection starts with a `hello` exchange that names the version. Unknown fields are ignored.

**44. A session holds many runs.** A client talks to a session, like in Nova. A follow-up sent after a run has ended starts the next run in the same session.

**45. HTTP with server-sent events, and WebSocket, both from the start.** The core only speaks frames. The two transports are thin layers over it.

**46. A `start` command begins a task.** It names the task and passes its inputs. `prompt` stays for chat-style use.

**47. Access.** Service bindings for other Grove workers, a bearer token for anything outside, and a tenant id stored on every session. Per-tenant sign-in is added later if someone else uses Lyra.

**48. The stateless calls stay out of Lyra.** Decision models, embeddings, speech, and transcription are single calls, not runs. They stay in Lumen.

## What Nova's protocol looks like

| Frame | Direction | What it is |
|---|---|---|
| `hello` | both | Names the version. The client lists which UI requests it can answer. |
| command | client to server | Do something. The frame's `type` is the command name (`prompt`, `steer`, `abort`). It may carry an `id`. |
| `response` | server to client | The outcome of one command, `ok` or an error. A successful `prompt` means "accepted", not "finished". |
| `event` | server to client | Something happened. Events carry a counter and a time. |
| `ui_request` / `ui_response` | both | The server needs a person (confirm, select, input, form) and waits for the answer. |

Error codes are stable strings: `bad_request`, `busy`, `not_found`, `permission_denied`, `unsupported`, `timeout`, `provider_error`, `internal`.

A run always ends with exactly one `run_end`, even on error or abort. A client treats the first `run_end` as the end of its request.

## Proposed: what Lyra keeps, drops, and adds

**Kept (Lyra's subset).**
- Frames: `hello`, command, `response`, `event`, `ui_request`, `ui_response`.
- Commands: `prompt`, `steer`, `follow_up`, `abort`, `get_state`, `get_messages`, `compact`.
- Events: `run_start`, `run_end`, `turn_start`, `turn_end`, `message_end`, `tool_call`, `tool_start`, `tool_update`, `tool_end`, `permission`, `usage`, `retry`, `compaction`, `error`, `queue_update`, `state_changed`.

**Dropped** (coding, terminal, and sign-in commands): `login`, `bash` as a user command, `reload`, `set_tools`, `get_extensions`, and the other terminal-interface and extension commands. Thinking events stay optional.

**Added** (Nova has no equivalent, because a Nova session is attended):
- **`start`**, a command that begins a task by name with its inputs, for example the timeline for a given date (decision 46).
- **`resume`** for a parked run.
- A way to **list pending requests**, so a viewer can show the glow (decision 36).
- A **parked** and **resumed** event.
- **Proposals** (decisions 50 to 53): a command to accept or reject one, and an event when one is decided.
- **Who is asking**: a tenant id and a credential in `hello` (decision 47). Nova assumes one trusted agent per server.

## The main difference: approvals are durable

In Nova, a `ui_request` is live. The server asks and waits while the connection stays open. In Lyra, a run parks and the pending request is saved in the record (decisions 34 to 37). So the answer may arrive hours later, from a different client, after the run's host was evicted.

Proposal: reuse Nova's `ui_request` and `ui_response` shapes for the content of a request and its answer, and make them durable.
- If a client is connected, the request is sent live as a `ui_request`.
- If not, it is saved, and any client can list it later and answer it with a `ui_response` that echoes the request id.
- Nova's optional `timeout_ms` and `default` map onto decision 37, with the default being deny.

## Proposed: a parked run and `run_end`

To keep a Nova client working, a parked run emits `run_end` with the reason `parked`. A `resume` then starts a new `run_start` that names the run it continues. The rule "the first `run_end` ends the request" still holds.

## Wire (decided, decisions 83 to 87)

This is the concrete shape, written so spec rows can have IDs (decision 62). It is decided. Only the parts that **differ from Nova** get rows here. For everything Nova specifies and Lyra keeps unchanged (framing, error handling of bad lines, unknown fields), Lyra's rule is "as in Nova's `docs/PROTOCOL.md`", and the tests port with it.

### Framing and hello

- UTF-8, one JSON object per line, split on `\n` only, `\r\n` accepted, empty lines skipped, unknown fields ignored. A bad line gets a failed `response` with `bad_request`, an unknown frame type or command gets `unsupported`, and neither is fatal.
- The line cap is **2 MiB**, configurable (decision 90). Nova's 64 MiB exists because a speech response carries audio, and Lyra carries none (decision 48). A record entry is capped at 1 MiB, below Cloudflare's 2 MB row limit.
- Client `hello`: `{type, version: 1, client, capabilities, tenant?}`. `capabilities` lists the request kinds the client can answer: `ui.confirm`, `ui.select`, `ui.input`, `ui.form`. `tenant` is only for trusted callers (see Access below).
- Server `hello`: `{type, version: 1, server, capabilities}`, with `capabilities` drawn from `steer`, `follow_up`, `compact`, `resume`, `proposals`.
- Over HTTP, the version travels in a header and there is no hello frame.

### Commands (decision 83)

| Command | Fields | Notes |
|---|---|---|
| `start` | `task`, `input`, `session?`, `key?` | Begins a task. Creates a session unless `session` is given. Answers `{session, run}`. `key` is an idempotency key: a repeat with the same key, task, and input returns the existing run, and the same key with different input is `conflict`. A cron retry must not start a second timeline run. |
| `prompt` | `session`, `text` | Chat-style: a user message that starts a run in an existing session. `busy` if a run is active, unless `queue` is set (as in Nova). |
| `steer` | `session`, `text` | Read by the model at the next gap between steps (decision 19). |
| `follow_up` | `session`, `text` | Read after the work would otherwise end. When nothing is running, it starts the next run in the same session (decisions 27 and 44). |
| `abort` | `session` | Stops the active run. The run is **parked** with the reason `stopped`, and can be resumed (decision 23). |
| `resume` | `session` | Resumes a parked run. `busy`, naming the pending request ids, if the run is waiting for a person. |
| `get_state` | `session?` | Run state, parked reason, pending request count, usage so far, queue sizes. |
| `get_messages` | `session`, `entry?`, `limit?`, `cursor?` | The record's entries, or the branch ending at `entry`, one page at a time, so a long record never makes a reply larger than the line cap. |
| `compact` | `session`, `instructions?` | Compacts now (decision 42). |
| `list_sessions` | `task?`, `state?`, `limit?`, `cursor?` | Sessions for the caller's tenant. |
| `list_pending` | `session?` | Pending approvals and questions, and open proposals, so a viewer can show the glow (decision 36). |
| `decide_proposal` | `proposal`, `decision: accept \| reject`, `note?` | Decides a proposal (decisions 50 and 53). A second decision is `conflict`. |

Dropped from Nova: `set_model`, `set_thinking`, `set_context_limit`, `set_tools`, `reload`, `get_commands`, `list_models`, `get_usage`, `run_command`, `bash` as a user command, the session commands that fork and navigate (decision 30), the login commands, the extension commands, and `decide`, `embed`, `speak`, `transcribe` (decision 48). Image attachments are not supported in version one.

Responses are Nova's: `{type: "response", id, command, ok, data}` or `{..., ok: false, error: {code, message}}`. The error codes are Nova's eight (`bad_request`, `busy`, `not_found`, `permission_denied`, `unsupported`, `timeout`, `provider_error`, `internal`) plus **`conflict`**, for a reused idempotency key with different input and for a second decision on the same proposal or request.

The session that does this (`src/protocol/session.ts`, decision 131) settles what the commands do when they cannot do what was asked. A task name the host does not run is `not_found`, at `start` and at a resume. A `start` into a session that already has a record is `conflict` unless it carries the same key, task and input, so a `prompt` or a `follow_up` is the second way to say anything and a client never accidentally starts a rival run. `steer` and `abort` with nothing running are `conflict`; `prompt` without `queue` during a run is `busy`; `resume` and `compact` while a run is active are `busy`, because a compaction there would change the view under a step in progress. A `prompt` carrying `queue` is queued like a follow-up, and with nothing running a `prompt` and a `follow_up` do the same thing: they continue the session's record.

### Events (decision 84)

Every event carries `seq`, `ts`, `session`, and `run`. Kept from Nova unchanged: `run_start`, `turn_start`, `turn_end`, `message_start`, `text_delta`, `message_end`, `thinking_*` (optional), `tool_call`, `tool_start`, `tool_update`, `tool_end`, `permission`, `usage`, `retry`, `compaction`, `queue_update`, `error`, and the `ui_expired` notice.

New:
- **`parked`** `{run, reason, detail?}`, with `reason` one of `waiting_for_person`, `limit`, `stopped`, `stuck`, `model_unavailable`. For `stuck`, `detail` can be `recipe_changed`, with the tools that differ (decision 91).
- **`resumed`** `{run}`.
- **`fallback`** `{run, from, to, reason}`, when the recipe's fallback model takes over (decision 58).
- **`ui_resolved`** `{id, by}`, so other clients close a dialog that was answered elsewhere.
- **`proposal`** `{run, proposal: {id, payload, evidence, state}}` and **`proposal_decided`** `{proposal, decision, note?, by}`.

**`run_end`** `{run, reason, turn, usage, parked_reason?}`, with `reason` one of **`done`, `parked`, `failed`**. This differs from Nova's `done`, `exhausted`, `aborted`, `error`. In Lyra a limit and a stop both park a run so it can be resumed (decisions 22 and 23), so `exhausted` and `aborted` become `parked` with a `parked_reason`, and `error` becomes `failed`, which is reserved for a run that cannot continue (for example an unreadable record). A run still always ends with exactly one `run_end`, and a client still treats the first one as the end of its request.

### Requests: durable approvals and questions (decision 85)

Nova's `ui_request` and `ui_response` shapes, made durable. A request is saved in the record before it is sent, then sent live as a `ui_request` to any connected client that declared the kind, and otherwise listed by `list_pending`.

| Field | Meaning |
|---|---|
| `id` | An unguessable random identifier (128 bits), assigned by the server. |
| `run`, `kind` | The run, and `confirm`, `select`, `input`, or `form` (decision 34's approval, choice, and question). |
| `title`, `message` | What is being asked. |
| `preview?` | The thing to look at before answering. For Reverie, the whole set of changes. |
| `tool?`, `args?`, `risk?` | For an approval of a tool call: which tool, a summary of its arguments, and its risk label. |
| `timeout_ms?` | After this, the request resolves to its default, which is **deny** (decision 37). |

- **Answers cannot be forged, and need no extra code.** The id is unguessable and single use. A second answer to the same id is `conflict`, and an answer to an unknown or expired id is `not_found`. This answers the "one-time codes" open question.
- A `ui_response` is `{type: "ui_response", request, session, ok?, note?, text?, ids?, cancelled?}`, with `note` read by the model on a deny (decision 34). It names the request with `request` rather than Nova's `id`: every frame in Lyra already carries an `id`, and one frame using it for something else is a trap for whatever reads frames next. `session` is there because HTTP has no connection to say which session is being answered. `ok` must be `true` to approve; anything else, including `cancelled`, is a deny (decision 37's default). `text` answers a question and `ids` answers a choice, and an id the request did not offer is `bad_request`.
- Over HTTP, `POST /v1/ui_response`. A client that is not connected simply answers later, possibly from a different client and after the run's host was evicted.

### Replay from the record (decision 86)

Events that come from a record entry (everything except live deltas) carry the entry's position as `seq`. So a client that reconnects with `Last-Event-ID` gets every missed event by reading the record, with no separate buffer. Live-only events (`text_delta`, `thinking_delta`, `tool_update`) are not replayed. This also fixes Nova's weakest point: a client that stops reading is dropped after 1024 events, and in Lyra it can come back and catch up.

- **HTTP:** `POST /v1/commands` takes one command and returns its response. `GET /v1/events` is a server-sent-event stream, with a session filter. `POST /v1/ui_response` answers a request. `GET /v1/state` is `get_state`.

The projection is written (`src/protocol/events.ts`, decision 130) and settles four details. A `resumed` status is both a `resumed` and a `run_start`, because a resume begins a new segment of the same run. The turn count and the usage total carry across a segment, so a `run_end` reports the run rather than the segment it ended. A tool result names its tool by looking its call up in the record. A user message, a changed pin and a note are in the record but are not events.
- **WebSocket:** `GET /v1/ws`, the same frames in both directions, with the same replay on reconnect.
- On Cloudflare, a Durable Object holds each session, so a WebSocket can hibernate while a run is parked. Confirmed against the current API on 2026-11-16: `ctx.acceptWebSocket(server)` is what allows hibernation (`ws.accept()` does not), messages arrive at `webSocketMessage(ws, message)`, closures at `webSocketClose`, and the client stays connected to Cloudflare while the object is out of memory, so a parked run's socket survives an eviction and the object is reinitialised on the next frame. Two details matter for Lyra. Per-connection state that must survive goes in `serializeAttachment` and comes back from `deserializeAttachment`, capped at 16,384 bytes, which is ample for a session id and a last `seq`. And **a scheduled alarm prevents hibernation**, so a run parked with a wake time is awake until the alarm fires; the plan is unchanged (one alarm per session, decision 72) but the cost model should expect duration billing for that window rather than free hibernation.

### Access (decision 87), and who may approve (decision 88)

Decision 47 stays: other Grove workers use a service binding, and anything outside needs a bearer token. A trusted binding caller names the tenant in `hello` (or a header over HTTP). A token caller's tenant comes from the token. Every session stores its tenant id, and every command is checked against it. A command naming another tenant's session is `not_found`, not `permission_denied`, so session ids do not leak. A request can be answered by a caller whose tenant owns the session (decision 88). Approving with edited arguments is not in version one: a deny with a note lets the model try again.

### Spec rows

IDs use these prefixes: `FRM` framing and hello, `CMD` commands, `EVT` events, `REQ` requests, `HTP` HTTP, `WSK` WebSocket, `ACC` access. Rows for behavior the same as Nova's are not repeated.

| ID | Case | Expected |
|---|---|---|
| CMD01 | `start` with a new key | Creates a session and a run, answers `{session, run}` |
| CMD02 | `start` repeated with the same key, task, and input | Returns the same run, starts nothing |
| CMD03 | `start` with the same key and different input | `conflict` |
| CMD04 | `follow_up` while a run is active | Queued, read after the work would otherwise end |
| CMD05 | `follow_up` when no run is active | Starts the next run in the same session |
| CMD06 | `abort` on an active run | Run parked with reason `stopped`, resumable |
| CMD07 | `resume` on a run parked for a stop or a limit | New `run_start` that names the run it continues |
| CMD08 | `resume` on a run waiting for a person | `busy`, naming the pending request ids |
| CMD09 | `list_pending` with an approval and an open proposal | Both listed with enough content to answer |
| CMD10 | `decide_proposal` twice | Second is `conflict` |
| CMD11 | `get_messages` with an `entry` | The branch ending at that entry |
| CMD12 | `get_messages` on a record longer than one page | A page and a cursor, never a reply over the line cap |
| CMD13 | A command whose text is over the entry cap | `bad_request` |
| CMD17 | `prompt` in a session | `busy` while a run is active unless `queue` is set, in which case it is queued like a follow-up; with nothing running it continues the record like a follow-up |
| CMD18 | `get_state` in a session | The run id, its state, any parked reason, usage so far, turns, and the queued steers and follow-ups |
| CMD19 | `steer` in a session | Read at the run's next gap; with nothing running it is `conflict` and nothing is queued |
| CMD20 | `compact` in a session | With a run mid-step it is `busy` and nothing is written; otherwise it summarizes the record now, saving a `compaction` entry with trigger `manual` (and the person's own instructions hashed with it), and answers `{session, run, compacted: true}`; a history with nothing to cut answers `compacted: false` and writes nothing; a session with no record is `not_found` |
| FRM01 | A line over the 2 MiB cap | Protocol error that closes the connection, as in Nova |
| FRM02 | Bad lines, unknown frames and unknown fields | A line that is not JSON, JSON that is not an object, and a frame with no `type` are each `bad_request`; an unknown `type` is `unsupported`; an unknown field is kept and ignored; none of them is fatal |
| FRM03 | Bytes arriving in pieces | Several lines in one chunk, one line across many chunks, `\r\n`, empty lines, a multi-byte character split across chunks and a U+2028 inside a string all come out as the lines that were sent |
| FRM04 | The response frame | A command's result becomes `{type, id, command, ok, data}` or `{..., ok: false, error}`, a code this build does not know becomes `internal`, and anything that is not that shape is not a response |
| CMD14 | A well-formed command | `start`, `prompt`, `steer`, `follow_up`, `abort`, `resume`, `get_state` and `get_messages` each validate into their typed shape with their fields, and a default fills in (`queue` is false) |
| CMD15 | A bad command | A frame that is not a command, a missing or empty `id`, a field of the wrong type and a missing required field are each `bad_request` naming the field |
| CMD16 | A command for a later slice | `list_sessions`, `list_pending`, `decide_proposal` and any name Lyra does not know are `unsupported` with a message, never a crash |
| EVT01 | Any run | Exactly one `run_end` with reason `done`, `parked`, or `failed`, and none after it |
| EVT02 | A limit is hit | `parked` with reason `limit`, then `run_end` `parked` |
| EVT03 | The fallback model takes over | A `fallback` event, and a record entry |
| EVT04 | A request is answered by one of two clients | The other receives `ui_resolved` |
| EVT06 | A resume finds a changed tool set | `parked` with reason `stuck` and detail `recipe_changed` |
| EVT07 | A record with a compaction | A `compaction` event carrying the entry's `seq`, its summary, how many entries it replaced and whether the run or a person asked for it, so a reconnect replays it |
| EVT05 | A client reconnects with `Last-Event-ID` | Receives every missed record-derived event in order, and no live deltas |
| REQ01 | A request is created | Saved in the record before it is sent |
| REQ02 | A request with no connected client | Listed by `list_pending`, answerable later |
| REQ03 | An answer to the same id twice | Second is `conflict` |
| REQ04 | An answer to an unknown id | `not_found` |
| REQ05 | A request with `timeout_ms` that passes | Resolves to deny, and emits `ui_expired` |
| REQ06 | Another wake-up arrives while a request is pending | Queued, not delivered, until it is answered |
| ACC01 | A command naming another tenant's session | `not_found` |
| HTP01 | `POST /v1/commands` with a command | The response frame, status 200, and `x-lyra-version` |
| HTP02 | A refused command, and each error code | The frame, and the status from its code: 400 `bad_request`, 403 `permission_denied`, 404 `not_found`, 409 `busy` and `conflict`, 501 `unsupported`, 504 `timeout`, 502 `provider_error`, 500 `internal` |
| HTP03 | A body that is not one frame, or is over the cap | `bad_request`, and nothing runs |
| HTP04 | The version header | Missing or `1` is accepted; anything else is `unsupported`, before a session is opened |
| HTP05 | `GET /v1/events` | A server-sent-event stream whose `id` is the entry's `seq`; `Last-Event-ID` sends only what follows it, and a live-only event has no `id` |
| HTP06 | A client that stops reading | Dropped once more than the cap is queued for it, and a reconnect with `Last-Event-ID` catches up from the record |
| HTP07 | `GET /v1/state` and `POST /v1/ui_response` | The `get_state` answer, and an answer routed to the session its frame names — through the handler and through the Worker's front door alike, with `not_found` for a request that session does not hold |
| HTP08 | Another path or method | `not_found`, as a frame |
| ACC01 | A command naming another tenant's session | `not_found` |
| ACC02 | No token from outside a service binding | Refused |

The framing, command, event, HTTP and access rows above are built as far as the approvals slice (WebSocket rows arrive with step 8). What is **not** built is proposals: `CMD10` stays in `scripts/unbuilt-rows.json` until that slice. `CMD08`, `CMD09`, `EVT04` and `REQ01` to `REQ06` are built with the approvals slice: `list_pending` answers, `resume` is `busy` while a person is deciding, `POST /v1/ui_response` answers, and the record projects `ui_request`, `ui_resolved` and `ui_expired`. `list_sessions` needs an index across sessions, which is a design of its own, so it answers `unsupported` for now too. Image attachments and Heartwood sign-in are not in version one.

## Settled

- The shell-related frames, if any. Answered: a `bash` tool call is an ordinary `tool_call` and needs none.
