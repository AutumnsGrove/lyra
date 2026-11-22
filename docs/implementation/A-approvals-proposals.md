---
title: "The approvals and proposals slice"
status: planning
category: features
---

# The approvals and proposals slice

Last updated: 2026-11-21. Read [`README.md`](README.md) first. Branch: `feat/step-09-approvals`, from a `main` with step 7 merged. Builds decisions 34 to 37, 50, 52, 53, 84, 85 and 88: everything that waits for a person. Autumn named this slice next and WebSocket after it (2026-11-21), so it is built before step 8.

`first-slice.md` lists approvals and proposals under **Later**, not in version one, so this slice has no line in that build order and no step number. Its done-when is the protocol's own rows plus the ones this document adds, and the one thing it must not do is put step 8 behind it: everything here stays additive to the record, the protocol and the loop.

Read: `docs/approvals.md` (the owner), `docs/consumers.md` ("Proposals"), `docs/protocol.md` ("Commands", "Events", and the requests section, which has the frames), `docs/run-record.md` (the entry table and decision 90), `scripts/unbuilt-rows.json` (the 10 rows this closes), step 2's waking and resume, step 6's session and HTTP handler, and step 7's `compaction` entry as the pattern for a new entry kind.

## Goal and done when

**A run that needs a person stops, asks, waits at no cost, and carries on when answered; and a finished run can leave a proposal a person decides later.**

Concretely:

- a tool marked `ask` parks the run as `waiting_for_person` with a request saved in the record before anything can be shown;
- a `ui_response` answers it — approve, deny with a note the model reads — and the run resumes and finishes;
- a recipe's policy (`allow`, `ask`, `deny`, or a risk label that sets the default) is enforced before a tool runs, and a run with no one to ask denies rather than parking;
- a request with a timeout resolves to deny when it passes, and says so with `ui_expired`;
- `list_pending` lists an approval and an open proposal with enough to answer each, a second answer to a request is `conflict`, an unknown or expired one is `not_found`, and the other client sees `ui_resolved` (CMD08 to CMD10, EVT04, REQ01 to REQ06);
- a run that proposes ends with a proposal entry, a `proposal` event, and a `decide_proposal` that answers once and refuses twice with `conflict`;
- a wake that arrives while a request is pending queues and does not deliver the run behind the question (REQ06).

## Slices

**Slice 1: the request, the policy, and the check.** The `request` entry kind; `Tool.policy` and `Tool.risk` with the default rule; the loop's check before a batch runs; `deny` answered as an error result without asking; `ask` saving the request and parking; `RunConfig.canAsk` and the "nothing can deliver it, so it is denied" rule. Rows (prefix `APR`, in `approvals.md`): APR01 an allowed call runs untouched; APR02 an `ask` call parks with a request saved before it is sent (REQ01); APR03 a `deny` call never asks and answers with an error; APR04 a run that cannot ask denies instead of parking; APR05 the risk label sets the default and a policy overrides it; APR06 a tool that says nothing is allowed, and why.

**Slice 2: answering, resume, and the timeout.** The `request_answered` entry; the resume path that answers the call the request was for; a second answer is refused where it is written; the timeout scheduled through the Waking slot and resolved to deny with `ui_expired`; the queued-wake rule. Rows: APR07 an approved call runs and its result is the model's; APR08 a deny with a note is what the model reads; APR09 a request answered twice is `conflict` and the first answer stands (REQ03); APR10 an unknown or expired request is `not_found` (REQ04); APR11 a timeout resolves to deny and emits `ui_expired` (REQ05); APR12 a wake behind a pending request waits for the answer (REQ06); APR13 killed before and after the request entries, the resume answers once.

**Slice 3: the protocol surface.** `ui_response` over HTTP and the session; `list_pending`; `resume` on a waiting run is `busy` naming the ids; `get_state.pending` becomes real; `ui_resolved` for the second client; and the projection of the two new entry kinds. Rows: CMD08 (`busy` naming the ids), CMD09 (`list_pending` with an approval and a proposal), EVT04 (`ui_resolved`), REQ02 (no connected client, answerable later).

**Slice 4: a question, not an approval.** The shared "ask a human" tool in the testkit — a question and a choice — proving decision 34's "the same mechanism", with the answer handed to the tool as its result. Rows: APR14 a question parks and its answer is the tool's result; APR15 a choice's answer is one of the options it offered, and anything else is refused.

**Slice 5: proposals.** `createProposeTool`: a typed payload checked against a schema, evidence as references, saved as a `proposal` entry, ending the run `done`; `decide_proposal` with accept, reject and a note, saved as a `proposal_decided` entry and projected as an event; a second decision is `conflict` and an unknown proposal is `not_found`. Rows (prefix `PRP`, in `consumers.md`): PRP01 a run ends with a proposal entry and event; PRP02 the payload is checked where it is written; PRP03 a decision is an entry and an event; PRP04 a second decision is `conflict` (CMD10); PRP05 an unknown proposal is `not_found`; PRP06 a proposal survives a resume and is still listed.

**Slice 6: the wrap-up.** `unbuilt-rows.json` empties (the `_note` says so, and `matrixcheck` runs on an empty list), `protocol.md` says what is built, `approvals.md` and `consumers.md` gain their row tables and lose their "Not discussed yet" entries that this settles, `run-record.md` gains the three entry kinds, the README's status, `AGENTS.md`, `CHANGELOG.md`, `decisions.md`, and `notes.md`.

## Settled here

- **A tool that says nothing is allowed.** Decision 35 gives a risk label the power to set the default, and the timeline's tools all allow; making silence mean `ask` would stop every existing recipe at its first call and change what a run means for everyone who upgrades. A caller who wants asking says so, by label or by policy. Recorded as a decision.
- **`canAsk` is the run's, defaults to false, and the host sets it.** Decision 35's "if nothing can deliver the question, it is denied" needs a fact the core can see. A headless runner leaves it false; a session sets it true, because a session is where a person can be reached. The session object, the HTTP handler and the dev client all inherit it from the session.
- **The answer is two entries, not one.** `request_answered` is written before the tool result, because a viewer needs the person's own line and the loop needs an answer that replay pairs with the call. It also gives the second-answer rule something to check.
- **Expired is `not_found`, not `conflict`.** Decision 85 says an unknown or expired id is `not_found`; only a second answer to a request still open is `conflict`.
- **The timeout is a wake.** A request with `timeoutMs` schedules one through the Waking slot, so a parked run still costs nothing and the alarm does the denying. A host with no Waking slot has no timeout, and the request waits indefinitely, which is decision 37's default anyway.
- **`ui_resolved` is record-derived.** It comes from the `request_answered` entry, so a second client that reconnects gets it with its `seq` like every other record event, and the live-only events stay the three they are.
- **A proposal ends the run.** `createProposeTool` behaves like `finish` for the loop's purposes — the run ends `done` — but saves a `proposal` entry instead of only a done-check, and its arguments are checked against a schema the recipe supplies.
- **The request's kinds are `approve`, `question` and `choice`.** One command answers all three (`ui_response`), which is what decision 34 means by one mechanism.

## Judgment calls left for building

- The exact shape of `preview` (a string or JSON) — decision 34 leaves it to the caller; a JSON value covers both.
- Whether `list_pending` shows a denied request. It does not: a request that has been answered is history, and the list is what still needs a person.
- How a question's `answers` field is shaped for a `choice`. The protocol's frame has `text`, `ids` and `answers`; a choice uses `ids` for the chosen option ids and nothing else.

## Mechanics changed in this slice

New record kinds: `request`, `request_answered`, `proposal`, `proposal_decided`. `Tool` gains `policy` and `risk`. `RunConfig` gains `canAsk` and `approvals` (a timeout and a default policy). `ParkedReason` gains `waiting_for_person` (decision 84 already names it). The protocol gains `list_pending` and `decide_proposal` as commands and `ui_response` as an HTTP route, and two commands leave `unsupported`. No new entry point and no dependency.

If this passes the README's split threshold (about 2,000 changed lines of non-test, non-doc code) at the slice 4 boundary, stop and propose splitting approvals from proposals rather than opening a very large PR.
