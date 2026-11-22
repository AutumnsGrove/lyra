---
title: "Lyra context size and compaction"
status: planning
category: features
---

# Context size and compaction

Last updated: 2026-11-21. Everything here is decided, and step 7 built it.

## The problem

A model can only read so much at once. A long run, or a run with bulky tool results, can outgrow that. When it does, something has to give: older material is dropped or shortened so the run can go on. That is compaction.

## What Nova and Pi do, and why Lyra differs

Nova (and Pi, similarly) are coding agents with open-ended chats. Nova's compactor:

- Triggers when the estimated token count passes the model's limit minus a reserve (the reserve is 16,384 tokens or 10% of the limit).
- Uses the token count the provider reported for the last request, plus a rough estimate for anything newer.
- Keeps the most recent 20,000 tokens verbatim.
- Asks the model to summarize everything older under fixed headings: Goal, Constraints and preferences, Progress, Key decisions, Next steps, Critical context. It keeps exact identifiers and file paths, and updates an earlier summary in place.
- Never cuts between a tool call and its result.
- Never changes earlier history except at a compaction, because a stable prefix keeps the provider's prompt cache working.

Almost all of that is shaped for a coding chat. The goal drifts as a person steers, and the state of the work is files on disk, so a summary mainly says which files were touched.

Lyra's runs are different in four ways:

1. **The goal is fixed and known.** A run has task instructions and a done-check. There is nothing to summarize about "the goal".
2. **Tools own the state.** The timeline's half-built page and its handle map live in the tools and the record, not on disk. After a compaction the model can be shown the current state exactly, straight from the tools, instead of a paraphrase.
3. **Runs are short.** Most will never compact. It is a safety net, so it should stay small.
4. **The task knows what matters.** A task can say what must survive. A coding agent cannot.

## Decided (2026-11-15)

**39. The record keeps everything, and the model sees a built view.** Compaction never deletes from the record (decisions 28 to 33 stay intact, and replay still works). It adds a `compaction` entry holding the summary and a pointer to the first entry kept. The model's view is built from the record: the pinned instructions, the summary, then the entries from the pointer on. The cut never falls between a tool call and its result, and the most recent steps stay verbatim.

**40. What survives is decided by the task.**
- The task's instructions are pinned and never summarized.
- Tools can supply a "current state" text, shown to the model after a compaction. For the timeline that is the page so far. It is exact, and it replaces prose wherever a tool can provide it.
- The task supplies the summarizer's instructions for the rest, with a generic default (progress, decisions, open items, exact identifiers). A new summary updates the old one.
- Bulky tool results are capped when they arrive, with a note on how to get more (for example, "truncated; call `get_diff` for the rest"). This never disturbs earlier history, so the prompt cache is kept.
- The summary is written through the Model slot. It is the same model as the run by default and can be set per task. Its usage is recorded in the compaction entry.

**41. When it triggers.** When the last request's input tokens, which Lumen already reports, pass the model's context window minus a reserve. The reserve and the amount of recent history kept are configurable per task, with defaults chosen when building. The model's context window is new data: a `contextWindow` field per model in `lumen-models.json` (see `lumen-changes.md`, item 7). If the very first message already exceeds the window, compaction cannot help, and the run fails clearly with "input too large" (the known limit in decision 6).

## How likely is this to fire?

Rarely. Most tasks are small and narrow, and most current models have context windows around a million tokens. A normal timeline day fits easily.

Two honest caveats. Nova's OpenCode Go catalog assumes a conservative 200,000-token window for its models until it can read the real one, so a runner using OpenCode Go with a lot of shell output could still reach it. And with a big window, the practical limit is usually money, not memory: every step re-sends the whole conversation. The optional cost and step limits (decision 18) matter more than the compactor.

## Also decided

**42. Compaction is part of the first version.** It will rarely fire, but Autumn wants it from the start. The first version includes the summarizer, so a long run never has to stop at the limit. I had proposed leaving it out and building it when a task first needed it. The answer was to include it.

## Not discussed yet

- **The summarizer's default instructions.** Written when it is built.

## The rows compaction is built against (step 7)

The cut is a pure function over the entries the model would see, and it is where
the rule that matters lives: it never separates a tool call from its result, and
it never cuts a history that already fits. The estimate is four characters to a
token, a smoke alarm rather than billing (decision 41), so the rows here ask about
boundaries and pointers rather than about exact counts.

| ID | Case | Expected |
|---|---|---|
| CMP01 | Happy: a normal cut | A history of several steps and a budget for the last of them cuts at a step boundary that keeps the most recent work inside the budget, and `replaces` counts the entries before it; a budget that lands between a call and its result moves back to the call |
| CMP02 | Property: any history, any budget | A history that already fits gives no cut; otherwise the cut starts a whole step, keeps every result with its call, fits the budget or is the last step because nothing later would fit |
| CMP03 | Empty and one-step histories | An empty history, and a history with one step, give no cut however small the budget |
| CMP04 | A history of huge steps | A history where every step is over the budget still cuts at a step boundary, keeping the last whole step |
| CMP05 | `firstKept` always exists | For any generated history that cuts, `firstKept` names an entry in that history, at the position the cut reports |
| CMP06 | Happy: the view | The conversation is the latest summary, then each tool's current state, then the entries from the pointer on, in that order, with the instructions left as the system text; a record with no compaction is the whole conversation, unchanged |
| CMP07 | Happy: replay after a compaction | Replaying the full record rebuilds the recipe's state exactly as the live run had it, because every tool message is applied, including those the summary stands in for |
| CMP08 | A second compaction | The view shows only the newest summary and the entries after its pointer, and the material the second summary is written from begins with the first summary and covers only the steps it never saw |
| CMP09 | Bad: a future field | A compaction entry carrying a field this build does not know loads with its known fields intact, and the field is dropped rather than carried along unread |
| CMP10 | Happy: the trigger | A run with a known window compacts when the last reply's reported input tokens plus a four-characters-to-a-token estimate for what arrived since passes the window minus the reserve, and not when it does not; the record, the event and the next request all show it |
| CMP11 | No known window | A model slot with no `contextWindow` and a recipe with none never compact on their own, however long the run, and a slot that reports one does |
| CMP12 | Sad: the summary call fails | The run parks `model_unavailable` with detail `compaction_failed`, nothing is written that a summary would stand for, and a person's resume tries again |
| CMP13 | Sad: an empty summary | A summary that is empty or only whitespace parks the run the same way, because continuing on it would have lost the history |
| CMP14 | The summary's usage counts | The tokens the summary spent are in the run's usage and count toward its token limit, so the limit is reached a turn earlier than without it |
| CMP15 | Bad: the first message alone is too large | The run fails with `bad_request`, the message names `input_too_large` with the estimate and the window, the closing status keeps the detail, and no model request is made |
| CMP16 | Oversized older results | A result over the per-entry cap is cut for the summary call with a marker saying so, and the record keeps the whole result the model saw |
| CMP17 | Happy: the tool's current state | After a compaction the view carries exactly what the tool's `currentState` returns, in its own message after the summary, and the text is never stored: it is rebuilt from the record when it is needed |
| CMP18 | Happy: a result over the cap | A result larger than the cap is cut when it arrives, with a marker giving the bytes dropped and the tool's hint for getting the rest; the record, the event and the next request all carry what the model saw, and the entry records the count |
| CMP19 | A tool's state needs what the cap cut | A recipe whose state depends on a capped part keeps what it needs in `details`, so a live run and one replayed from the record build the same state |
| CMP20 | A summary over the entry cap | A summary long enough to pass one entry's cap is saved truncated with the marker, the view after the cut shows the summary the record holds rather than the longer one the model wrote, and the run goes on |
| CMP21 | Property: killed during a compaction | Killed before and after every append of a run that compacts, the resume reaches `done`, the record is the one the uninterrupted run wrote, every tool result is still there, and the conversation it replays is the same |
| CMP22 | A long run that compacts several times | A run of eleven turns and a small window compacts more than twice, ends `done`, builds the same page as the same script with no compaction, and each summary after the first updates the one before it |
