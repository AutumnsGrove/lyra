---
title: "Lyra approvals and questions"
status: planning
category: features
---

# Approvals and questions

Last updated: 2026-11-14. Everything here is decided.

## The problem

Some runs happen with nobody watching: the timeline overnight, a review on a runner. A few actions should not happen without a person saying yes (running a command that changes things, publishing something). Sometimes a run just needs an answer only a person has. The run should be able to stop, ask, wait at no cost, and carry on when answered.

This builds on what is already decided: a run can be parked with a reason (decision 22), it resumes where it stopped (decision 20), and the record holds everything (decisions 28 to 33).

## Decided

**34. One mechanism for approvals and questions.** When a run needs a person, it saves a pending request in the record and parks with the reason "waiting for a person". A request is one of three kinds: an approval ("run this command?"), a question ("which branch?"), or a choice. The person answers with approve, deny (with an optional note the model reads, so it can adapt), or the answer to the question. The run then resumes. The shared "ask a human" tool and the approval check on risky tools are the same mechanism.

**35. A policy per tool, set in the task's recipe.** Each tool is marked allow, ask, or deny in the task's recipe. A tool also carries a risk label (reads only, changes things, dangerous), and the label sets the default: reads are allowed, changes and dangerous tools ask. A recipe lists its tools and their policy up front, so most calls never ask. The timeline's tools all allow. If a call needs an answer and nothing can deliver the question, it is denied. A runner with no one to ask therefore never waits forever on something it was not allowed to do.

**36. A waiting run shows as a simple indicator.** No email and no push. A run that is waiting is shown as a soft glow. The core only makes waiting runs easy to see: it can list the pending requests and what each one asks. The glow is part of the viewer, built later (decision 28). A separate notify slot is not needed for now. A host with no viewer means any request that needs an answer is denied (see 35).

**37. An optional timeout per task.** A parked run costs nothing while it waits, so the default is no timeout. A task can set one, after which an unanswered request is denied.

### Design notes

- **While a request is waiting, other wake-ups queue.** A finished background job or a follow-up must not wake the run behind a pending question, because the model would carry on while a person is still deciding. They are held until the request is answered. This comes from Autumn's `pi-background` extension, which learned it with a question form.
- **Answers must be genuine.** Each request carries a one-time code, so an answer to it cannot be forged. The exact scheme is decided with the transport.
- **The shell tool needs a command policy.** Nova's approach is the reference: an allow-list of command patterns, anything else asks, and a headless run denies. Allow rules reject shell control operators, so an allowed command cannot be chained into something else, and the most restrictive matching rule wins. The exact patterns are decided when the shell tool is.

## The rows approvals is built against

Decision 34's one mechanism is two things that behave the same: a risky call the
recipe wants a person to approve, and a question only a person can answer. The
policy is decided per call before anything runs, and a call that needs an answer
stops the batch rather than being guessed at.

| ID | Case | Expected |
|---|---|---|
| APR01 | Happy: a call the recipe allows | It runs untouched, with no request and no park |
| APR02 | Happy: a call that asks | The run parks as `waiting_for_person`, the request is saved before anything is sent, the tool never ran, and a resume with no answer parks again and writes nothing |
| APR03 | Sad: a call the recipe denies | It never asks and never runs, and the model is told why in an error result it can adapt to |
| APR04 | Sad: nothing can deliver the question | A run with nobody to ask (`canAsk` false) denies the call instead of parking, which is decision 35's "it is denied" |
| APR05 | The policy's order | A risk label of `changes` or `dangerous` asks and `reads` does not; a tool's own policy wins over its label; and a batch stops at the first call that needs an answer, leaving the calls after it unanswered |
| APR06 | A tool that says nothing | It is allowed, because silence meaning "ask" would stop every recipe built before this slice |
| APR07 | Happy: an approved call | The call runs on the resume, once, and its result is what the model reads next |
| APR08 | Sad: a denied call with a note | The call never runs, and the person's own words are in the error result the model corrects from |
| APR11 | Sad: a timeout | A request past its `timeout_ms` is denied by the clock, the record says it expired rather than that a person decided, the host had a wake scheduled for it, and a wake does not overrule the park before then |
| APR12 | Bad: an answer that is not one | A `ui_response` that is a different frame type, names no request or session, or carries a field this build cannot read is `bad_request` naming the field; anything but a clear `ok: true` is a deny; an unknown field is ignored; and no hostile frame makes the decoder throw |

## Not discussed yet

- **Who may approve** and **approve with edits.** Proposed in decision 88: the session's owner, and no edited approvals in version one.
- **How the indicator works in the viewer.** Built later, on top of the list of pending requests.
- **The shell tool's command policy.** Decided in decision 81, with details in `shell-tool.md`.
