---
title: "Lyra limits, interruptions, and failures"
status: planning
category: features
---

# Limits, interruptions, and failures

Last updated: 2026-11-17. Everything here is decided.

## What a run is

A run is one job from start to finish: the loop of asking the model, running a tool, and handing the result back. This document is about how a run stops, how it gets interrupted, and what happens when something goes wrong.

## Decided

**Limits (decision 18).** A run can be limited by steps, tokens, time, or cost. Each is optional. The core's default is no limit on any of them. A task can set any of them in its recipe. A cost limit works only when the model adapter reports real cost (decision 15).

**Stop and steer (decision 19).** A Wanderer or Autumn can stop any run partway, and can steer it by sending a new message that redirects it. These are always available, whatever the task.

- A **stop** cancels the model request in flight and tells a running tool to stop.
- A **steer** message is read by the model at the next gap between steps. It does not cut in mid-sentence.
- How a person reaches these (a button, an HTTP call, a command) is part of the transport discussion later. The core only guarantees that a run can be stopped and steered.

**Follow-up (decision 27).** A message can be queued during a run and is read after the work would otherwise end, in the same conversation. It sits next to stop and steer. What a follow-up does when nothing is running is still open.

**Resume (decision 20).** An interrupted run resumes where it stopped. It does not start over.

**Failures (decision 21).** If a tool call fails or has invalid arguments, the error goes back to the model as the tool's result, and the model fixes it in the next call. This is the same mechanism as the timeline's validation ("no such repo, here are the real ones"). Bad model output happens whenever AI is involved, and Lyra does not try to design it away. The narrow cases in item D above are about not acting on it, not about preventing it.

## How resume works

After every model reply and every tool result, Lyra saves the record to the Storage slot before going on. Write down what is about to happen, do it, then write down what happened. The saved record is the progress. Resuming means loading the record and continuing the loop.

### The one wrinkle

If the interruption lands in the middle of a tool call, nobody knows whether the tool finished. Two cases:

- **A read** (get a diff, read an issue) can safely be run again.
- **A tool that changes something** might do it twice if run again.

So each tool declares whether it is safe to repeat. The default is no. When an unsafe tool was cut off, Lyra does not run it again. It tells the model "the outcome of this call is unknown, check before repeating". For the timeline, the reads are safe, and the page-building tools are made safe another way: each call has an id built from the run and the step, so a repeated `add_line` with the same id changes nothing.

A model request that was in flight when the interruption landed is simply asked again. It costs one extra call. Avoiding that would need request ids in Lumen, which is not worth it yet.

## Resuming after a deploy

Deploys evict Durable Objects once or twice a day, so a long run often resumes on new code. The run's header pins the recipe it started with, and a resume checks the tool set against it. The same tools mean it continues. A changed tool set parks the run as stuck with the detail `recipe_changed` until a person resumes it (decision 91). A reworded prompt alone does not stop a run. See `run-record.md`.

## A run's life

| State | Meaning |
|---|---|
| running | In the loop. |
| parked | Paused with its record saved, and resumable. Always has a reason. |
| done | Finished, and the task's done-check passed. |
| failed | Cannot continue (for example, the record is unreadable). Rare. |

Reasons a run can be parked: waiting for an approval, a limit was reached, stopped by a person, stuck, or the model is unavailable. A crash or eviction is not a state. It resumes automatically (item B below).

## Also decided (proposals confirmed 2026-11-14)

**A. Hitting a limit parks the run.** It does not kill it. Everything done so far is kept, and the run can be resumed with a larger limit, or left. This follows from decision 20: a limit is a pause.

**B. Accidents resume on their own, and stops wait for a person.** If the host crashes or evicts a run, the Waking slot resumes it without anyone asking. If a person stopped it, it stays stopped until told to resume.

**C. Each tool declares whether it is safe to repeat.** The default is no. An unsafe tool that was cut off is reported to the model as an unknown outcome, not run again. See "The one wrinkle".

**D. Done is decided by the task's done-check, not by the model's say-so.** For the timeline that means `finish` was accepted. Alongside it:
- If the model stops without finishing, Lyra reminds it a small number of times, then parks the run as stuck.
- If a tool fails the same way several times in a row, Lyra parks the run as stuck. This is the one default-on safeguard, because the default has no limits and a stuck loop spends a Wanderer's own provider key. It is configurable per task: whether it is on, and the counts.
- A reply that was cut off by the token limit never runs its half-written tool arguments. It counts as a failure and the model is asked again. This needs Lumen to report a finish reason (`lumen-changes.md`, item 2).

**E. A failing model call is retried 3 times with staggered, increasing delays, then the run parks as "model unavailable".** The exact delays are configuration, chosen when building. Lumen's router does no fallback to another model when tools are present, so these retries, and an optional fallback model named in the task's recipe (decision 58), are the only protection for agent calls (see `lumen-changes.md`). If the fallback also fails, or none is named, the core parks the run.

## Rows (step 2, slice 2)

Each limit is optional, and there are none by default (decision 18). The check
happens before each model request, so reaching one parks the run at a step
boundary with everything done so far kept, ready to resume with a larger
allowance (decision 22). When two limits are reached at once, the first in
`steps`, `tokens`, `time`, `cost` order is the one the record names. Tokens are
input plus output summed over the replies that arrived; time is active time on
the injected clock since the `running` status, so a parked run costs nothing; a
cost limit counts reported cost of any source.

| ID | Case | Expected |
|---|---|---|
| LIM01 | Sad: each limit parks the run | A step, token, time and cost limit each park the run with reason `limit`, a status `detail` naming which one, one `run_end`, and a loadable record that keeps the work done so far |
| LIM02 | Happy: the step limit exactly reached | A run that finishes on its last allowed turn is `done`; one that needs another turn parks with detail `steps`; one that needs fewer turns finishes untouched |
| LIM03 | Bad: a limit that is not a positive number | Zero, negative, fractional, infinite and non-numeric limits are `bad_request` when the run is created, and nothing is saved |
| LIM04 | Happy: the time limit | Time is measured on the injected clock from the `running` status, so a model call and a tool each count toward it, a limit just over the elapsed time lets the run continue, and no real time passes |
| LIM05 | Sad: a cost limit with no reported cost | A reply that reports no cost writes one `note` entry (`limit_unenforceable`), the limit stops being enforced for the run, and the run carries on to its natural end |
| LIM07 | Property: the usage total | For any script, the tokens and cost summed over the replies that arrived equal the run's reported total, even when a later model call fails |

`LIM06` is a resume with larger limits, and lands with resume in slice 6, so the
planned number waits for it rather than being reused.

## Not discussed yet

- **Follow-up when nothing is running.** Decided 2026-11-16 (decision 100): it continues the conversation, appending the message and starting a run in the same session, so `follow_up` and `prompt` behave the same when the run is idle.
- **How the record is read.** Written since: `run-record.md`.
- **Approvals.** Decided in 34 to 37, with who may approve in 88 and the wait's reason in 84: a park with the reason `waiting_for_person`, and a viewer that reads the list of pending requests (decision 36).
- **A permission policy for the shell tool** (decision 16). Decided in 81 and 89, with the details in `shell-tool.md`.
