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
| LIM06 | Happy: a resume with larger limits | A run parked on a limit continues when a person resumes it with a bigger allowance, and the turns it already spent still count |
| LIM07 | Property: the usage total | For any script, the tokens and cost summed over the replies that arrived equal the run's reported total, even when a later model call fails |

## Rows (step 2, slice 3)

Stop, steer and follow-up are the three things a person may do to a run while it
is running (decisions 19 and 27). All three reach it through a `RunHandle`: the
signal stops it, and the two texts are queued and read at the moments that keep
the record paired. A steer is read at the gap after a tool batch is saved and
before the next request; a follow-up is read when the run would otherwise end.

| ID | Case | Expected |
|---|---|---|
| STP01 | Happy: a run is stopped | Aborting before the first request, during the model call, during a tool and between steps each parks as `stopped` with one `run_end`, every call of the batch paired and no timer left waiting; a second abort changes nothing |
| STP02 | Happy: a steer is read at the gap | A steer that arrives during a model call or a tool is saved as a `user_message` labelled `steer` after the tool results and before the next request, the next request carries it, and the call and result pairing is unbroken |
| STP03 | Sad: a steer after the run ended | Refused with `conflict`, and nothing is queued or saved |
| STP04 | Happy: a follow-up is read at the end | A follow-up queued during a run is saved as a `user_message` labelled `follow_up` when the run would end on an accepted `finish` or on the model stopping without one, and the run continues; several are read in arrival order |
| STP05 | Bad: text over the entry cap | A steer or a follow-up bigger than one entry is `bad_request`, nothing is queued, and the run is unaffected |

## Rows (step 2, slice 4)

A retryable model failure is tried again up to three times with growing delays
(decision 26), and each wait is a floor under the error's own `retryAfterMs`. What
is left after the retries is a fallback model if the recipe names one (decision
58), and otherwise a park as `model_unavailable`, because an outage is a pause
rather than a broken run. A non-retryable error is a bug, not an outage, so it
still ends the run `failed`.

| ID | Case | Expected |
|---|---|---|
| RTY01 | Happy: a retry succeeds | A retryable failure is tried again after the first delay and the turn finishes; the assistant entry records `retries: 1`, one `retry` event is emitted, and a retry is one step, not two |
| RTY02 | Sad: the retries are exhausted | After three retries with delays of 1 s, 4 s and 16 s the run parks `model_unavailable`, the status detail names the last error, and no timer is left waiting |
| RTY03 | Sad: the error is not retryable | Asked once, no retry event, no wait, and the run ends `failed` with that error |
| RTY04 | Happy: the provider says when to come back | The wait is the larger of the default delay and `retryAfterMs`, and the fake clock moves by it |
| RTY05 | Sad: a stop during the backoff | The wait is cancelled, the turn is not tried again, and the run parks `stopped` |
| RTY06 | Happy: the fallback model | After the retries the run moves to the recipe's fallback, writes one `fallback` entry and event naming both models and the reason, and continues on it |
| RTY07 | Sad: the fallback also fails | It gets the same retry policy and then the run parks `model_unavailable` |

## Rows (step 2, slice 5)

The stuck safeguard is the one protection that is on by default, because a recipe
has no limits unless it asks for them and a loop that cannot progress spends a
person's own key (decision 25). A model that stops without finishing is nudged
twice and then the run parks. A tool that fails the same way three times in a row
parks it too, where "the same way" is the same tool and the same first 200
characters of the error text, because a tool result carries no code of its own. A
success, or a different failure, starts the count again.

| ID | Case | Expected |
|---|---|---|
| STK01 | Happy: the model is reminded | A reply with no tool call and no finish is saved, a short `reminder` user message is saved after it, and the model is asked again |
| STK02 | Sad: the model keeps stopping | After two reminders a model that still does not finish parks `stuck` with detail `stopped_without_finishing`, and the record has exactly two reminders |
| STK03 | Sad: a tool fails the same way | Three identical failures in a row park the run with detail `repeated_failure` naming the tool |
| STK04 | Happy: the count resets | A different failure, or a success, starts the count again, so a script that never has three in a row finishes normally |
| STK05 | Sad: the safeguard is off | No reminder is written and the run never parks; a model that cannot finish ends `failed` and says the safeguard is off |
| STK06 | Sad: a reply cut off by the token limit | Each cut-off reply is none of its calls run, is asked again, and counts toward the same-failure total; three in a row park the run naming the cut-off reply |

## Rows (step 2, slice 6)

A resume reads the record and continues it, so a kill must never lose a turn or
repeat a call that changes something (decision 20). The record cannot say whether
a cut-off tool ran, so its unanswered calls are reported rather than assumed
(decision 24). What a record already spent counts toward the limits, so a run does
not get a fresh allowance each time it is interrupted (`LIM06`).

| ID | Case | Expected |
|---|---|---|
| RSM01 | Happy: killed at every write | Killed at every append, before and after it, on a three-tool script whose tools are safe to repeat, the resume ends `done` and its conversation and results are the uninterrupted run's, once unknown-outcome results are set aside |
| RSM02 | Sad: a tool that changes something | An unsafe call killed anywhere runs at most once across the original and the resume, and where its result was lost the model is told the outcome is unknown |
| RSM03 | Happy: who may resume what | A wake leaves a person's stop alone and writes nothing, a person continues it; a wake on a run this process is driving joins that run instead of starting a rival; and two alarms for the same dead run resume it once, with one `resumed` status |
| RSM04 | Bad: a record that cannot be used | A record that does not exist is `not_found`, one with no usable header fails the resume with `internal` and never throws, and a damaged last line is noted and skipped so the run continues |
| RSM06 | Happy: a person lifts a park | A resume by a person continues after a `model_unavailable` park, and after a `limit` or `stuck` park with the new limits, ending `done` |

## Not discussed yet

- **Follow-up when nothing is running.** Decided 2026-11-16 (decision 100): it continues the conversation, appending the message and starting a run in the same session, so `follow_up` and `prompt` behave the same when the run is idle.
- **How the record is read.** Written since: `run-record.md`.
- **Approvals.** Decided in 34 to 37, with who may approve in 88 and the wait's reason in 84: a park with the reason `waiting_for_person`, and a viewer that reads the list of pending requests (decision 36).
- **A permission policy for the shell tool** (decision 16). Decided in 81 and 89, with the details in `shell-tool.md`.
