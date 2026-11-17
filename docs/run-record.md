---
title: "Lyra run record"
status: planning
category: features
---

# The record of a run

Last updated: 2026-11-17. Everything here is decided. The entries, the loader, replay and their rows were built in step 1a, slice 3; the size cap and resume rows (REC01 to REC09) are step 2.

## What the record is

After every step, Lyra saves what happened to the Storage slot. That saved list does two jobs. It is the progress, so a run can resume where it stopped (decision 20). It is also the readable history of what Lyra did and why. It is one thing, not two.

## Decided

**The core only produces the record (decision 28).** It makes a clean, readable record. A viewer (an Arbor page, a file, or anything else) is built separately later, on top of it. This keeps the core small.

**The record holds the real data (decision 29).** Scrubbing happens only on the way to the model (decision 8). The record is private to the tenant and is never published. It never contains a provider key.

**A straight line now, with branches possible later (decision 30).** Nothing branches today, because stop, steer, resume, and follow-up are all linear. Every entry still carries its own id and the id of the entry before it. That is a straight line in practice and a tree in shape, so branches can be added later without changing the format.

## Decided: the shape (decision 31)

The record follows the shape of Nova's session file, so a Lyra record and a Nova session can be read by similar tools where they overlap. It is a header line, then one entry per line.

Every entry has four fields: `type`, `id`, `parent`, and `ts` (the time). The header has the record's version, the run id, the task name, the recipe's name, version, and tool-set hash (decision 91), the start time, and the host.

| Entry | What it holds | Written when |
|---|---|---|
| header | Record version, run id, task name, recipe name, version and tool-set hash, start time, host | At the start |
| message from the user | The job, or a steer or a follow-up (labeled which) | When it arrives |
| message from the assistant | The model's text and its tool requests, plus the model, tokens, cost and its source, finish reason, time taken, and retries | Right after the model replies, before any tool runs |
| message from a tool | The result: ok or error, what the model sees, and optional details for people | Right after the tool finishes |
| status | running, parked (with its reason, and the detail that names which part of it), resumed, done, or failed | On every change |
| fallback | The model the run moved to, the one that failed, and why (decision 58) | When the run moves |
| note | Something worth saying that is not a turn, with a `kind` a reader skips if it does not know it. The first is `limit_unenforceable`, for a cost limit with no reported cost (decision 15) | When it happens |

Other entry kinds are allowed. A reader skips kinds it does not know. A half-written or damaged last line is skipped and noted, never fatal (Nova does the same).

The model's tool request is saved before the tool runs, and the result after. That is the "write down what is about to happen, do it, write down what happened" rule from decision 20. No separate entry is needed for it.

### How it is stored

On Cloudflare, one row per entry in the Durable Object's SQLite. On Node, a JSONL file, or memory for tests. It is the Storage slot's job. In every case the same record can be exported as plain JSONL lines.

## Decided: how big an entry can be (decision 90)

Cloudflare's documentation gives a 2 MB limit on a string, BLOB, or row in a Durable Object's SQLite storage. An entry that cannot be saved would fail a run midway, so each entry is capped at 1 MiB by default (configurable, and always under the adapter's own limit). Content that could exceed it is truncated before saving, and the entry carries a marker with the number of bytes dropped:

- A tool result (the model has usually seen a capped version already, as `bash`'s 50 KiB tail).
- The model's reasoning text (decision 33).
- A proposal's evidence (decision 52).
- A user message, a steer, or a follow-up. A command whose text is over the cap is refused with `bad_request`, so the sender knows.

The structure of an entry (its ids, types, and small fields) is never truncated. Truncation never changes what the model saw during the run, only what is saved afterward, so replay (decision 32) rebuilds tool state from what was saved. A tool whose state would be wrong if its result were truncated has to keep its result under the cap on its own. The test is that no oversized input can make a save fail.

## Decided: which version of the recipe is running (decision 91)

A run can outlive a deploy, and deploys evict Durable Objects once or twice a day, so a resume often runs on new code. The header pins what the run started with, and a resume checks it:

| Situation on resume | What happens |
|---|---|
| Same tool-set hash, same version | Continue. |
| Same tool-set hash, new version or instructions | Continue, and save a `recipe_updated` entry noting the old and new version. |
| Different tool-set hash (a tool added, removed, or its arguments changed) | Park as stuck with the detail `recipe_changed`, listing which tools differ. A person's `resume` continues it with the new tools, and the record saves the change. |

The tool-set hash covers tool names and argument schemas, not the wording of the instructions, so a reworded prompt does not stop a run. A tool the model already called that no longer exists is the case this protects against.

## Decided: where progress lives (decision 32)

Some tools build something as the run goes. The timeline's tools build a page, and they hand out short handles (`c1`, `pr12`) that map back to real hashes. If the host loses the run partway, that half-built page and that handle map have to come back.

The record is the only place progress lives. On resume, Lyra replays the saved tool results to rebuild the half-built page and the handle map. There is no second copy to get out of step. Tools are written so that replaying their saved results rebuilds their state.

## Decided: the model's own reasoning (decision 33)

Some models return their reasoning text along with the answer. It is stored when the adapter provides it, marked as reasoning, so a viewer can show or hide it. It is the closest thing to "why". It can be large, and it is only kept when the model offers it.

## Not discussed yet

- **How much of a long run's record is sent to the model** when the record gets too large for the model's memory (trimming or summarizing). Separate topic.
- **How long a record is kept.** Settled in decision 51: records belong to the tenant.
- **A proposal entry** and a decision entry (decision 50). The record already allows new entry kinds.
- **The viewer.** Built later, on top.

## The rows the record is built against (step 1a, slice 3)

The loader is the one place a record made by anything at all is read, so it is
tolerant by design: a line it cannot use is skipped and noted, never fatal, and
a kind it does not know is kept exactly as it was saved so a newer writer's
entry survives an older reader. A record with no usable header is not a record
and is refused, because inventing a run id would make a resume pretend to be a
run it is not.

The record that `load` returns keeps entries in the order they were saved. The
*active path* is the chain from the last entry back through its parents to the
root, and it is the conversation the model sees on replay; it is a straight line
today and is a tree in shape, so a branch can be added later without changing
the format (decision 30).

| ID | Case | Expected |
|---|---|---|
| RCD01 | Happy: encode then load | A header and a chain of entries encode to lines and load back equal to what went in, with no notes |
| RCD02 | Happy: replay | The active path becomes the conversation: user, assistant with its tool calls, each result in call order, and status entries left out |
| RCD03 | Sad: a truncated last line | The line is skipped and noted, and everything before it still loads |
| RCD04 | Bad: a damaged or hostile line | A line that is not JSON, not an object, of the wrong shape for its kind, a duplicate id, a parent that is not in the record, or a parent chain that loops each load with a note; an unknown kind is preserved as an opaque entry with its raw line and skipped by replay |
| RCD05 | Bad: the header | A record with no lines, a first line that is not a header, or a header of a version this code does not know is refused instead of loaded |
| RCD06 | Property: any valid sequence | For any generated header and chain of entries, loading their encoding returns them unchanged and the active path is a path from the root to the last entry |
| RCD08 | Bad: a turn the model saved badly | An assistant turn whose call has an empty name or id, or two calls with one id, still loads and still replays, because the record keeps what happened; the strict reading of a reply (the adapter boundary) is what refuses those |
| RCD07 | Bad: hostile bytes | Any mix of valid lines and hostile ones loads or refuses without throwing, and no valid line is lost |
| RCD09 | Happy: the recipe's pin | A header's recipe keeps the instructions hash and one hash per tool through a save and a load, and a header from before those fields existed still loads without them |

## Spec rows

| ID | Case | Expected |
|---|---|---|
| REC01 | A tool result larger than the entry cap | Saved truncated, with a marker giving the bytes dropped |
| REC02 | Reasoning text or proposal evidence larger than the cap | Saved truncated, with a marker |
| REC03 | A user message larger than the cap | `bad_request`, nothing saved |
| REC04 | Any oversized input | The save never fails and the run does not fail for size: content is cut to fit, and only an entry whose *structure* alone is over the cap (thousands of calls in one turn) is refused, with the reason said out loud |
| REC05 | Resume with the same tool-set hash and version | Continues, with no extra entry |
| REC06 | Resume with the same hash and a new version or reworded instructions | Continues, and saves a `recipe_updated` entry |
| REC07 | Resume with a tool removed that the record already used | Parks as stuck with detail `recipe_changed`, naming the tool |
| REC08 | Resume with a tool's arguments changed | Parks as stuck with detail `recipe_changed`, naming the tool |
| REC09 | `resume` after a `recipe_changed` park | Continues with the new tools, and the record notes the change |
