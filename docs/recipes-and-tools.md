---
title: "Lyra: recipes and tools"
status: building
category: features
---

# Recipes and tools

The spec for what a task is: its instructions, the tools it may use, the limits it runs under, and what
counts as done (decision 5). It is the document step 3 of [`first-slice.md`](first-slice.md) builds, and
the rows a test cites live here. It adds no decisions; when it and `decisions.md` disagree, `decisions.md`
wins. The planned slices are in
[`implementation/03-recipes-and-tools.md`](implementation/03-recipes-and-tools.md).

A tool owns anything that has to be exact. It receives untrusted arguments, checks them against its own
schema, and answers with a result the model reads: an error is something to correct, never a crash
(decision 21). A recipe picks tools from the shared pile (`finish`, and later a human's word) and adds its
own.

## Argument validation

A tool's `parameters` is one piece of data doing three jobs: what the model is shown, what the tool-set
hash covers (decision 91), and what the arguments are checked against. Keeping it plain JSON Schema means
there is one source of truth and nothing to drift from it.

The subset is deliberately small: `type` (`object`, `string`, `number`, `integer`, `boolean`, `array`,
`null`), `properties`, `required`, `additionalProperties` (a boolean), `enum`, `items`, `minItems`,
`maxItems`, `minLength`, `maxLength`, `minimum` and `maximum`. There is no `pattern`, because a regular
expression written by a tool author is a denial-of-service door on hostile input, and no `$ref` or `oneOf`,
because a flat schema is enough for tool arguments. Unknown keys in an argument object are rejected, and
the message names the ones that are allowed, which is what lets a model correct itself.

A schema this build cannot understand is refused when the tool is defined, not silently ignored. A
validation failure never reaches the tool: the call becomes an error result with `bad_request` in its
details, and the model is asked again. The message is stable and specific, capped at ten errors and 2 KiB:

```
invalid arguments: arguments.repo: expected string, got number; arguments.extra: not allowed (allowed: repo, text)
```

| ID | Case | Expected |
|---|---|---|
| SCH01 | Happy: each type accepts its own value | `string`, `number`, `integer`, `boolean`, `null`, an `array` of its item type, and an `object` with its declared properties all validate |
| SCH02 | Happy: properties, required and optional | A required property present validates, an optional one left out validates, and `additionalProperties: true` allows an extra key |
| SCH03 | Happy: enums and arrays | A member of an `enum` validates, each array item is checked by its index, and `minItems`/`maxItems` bound the length |
| SCH04 | Happy: string and number bounds | `minLength`/`maxLength` bound a string, and `minimum`/`maximum` bound a number, at the exact edges |
| SCH05 | Sad: a required field is missing | The message names the missing field and says it is required |
| SCH06 | Sad: a value is the wrong type | The message says what was expected and what came, for a primitive, an array and an object |
| SCH07 | Sad: a number out of range or an enum miss | The message names the field, the bound and the value; an enum miss lists the allowed values |
| SCH08 | Bad: an unknown key | It is refused and the message lists the allowed names; a tool with no arguments lists none |
| SCH09 | Bad: the root is not an object | `null`, a list, a string, a number and a boolean are each refused, and so is an object where a string was expected |
| SCH10 | Bad: deeply nested input | Nesting past the depth cap is refused with a message, not a stack overflow |
| SCH11 | Bad: many errors and a long message | A thousand failures produce ten errors, and the formatted message stops at 2 KiB |
| SCH12 | Bad: a schema with an unsupported keyword | It is refused when the schema is compiled, naming the keyword: `pattern`, `$ref`, `oneOf` and an unknown name alike |
| SCH13 | Bad: a long string against `maxLength` | It is refused, and the value is not copied into the message |
| SCH14 | Bad: any schema and any value | Any schema-shaped and value-shaped input compiles or is refused and validates or returns errors, never throws and never loops (a fuzz target) |
| SCH15 | Bad: a malformed schema | A type outside the seven, `properties` that is not an object of schemas, `required` that is not a list of declared names, an empty `enum`, an `items` that is not a schema, and inconsistent bounds are each refused when it is compiled |
| SCH16 | Bad: prototype names | `__proto__` and `constructor` are ordinary keys: they never reach a prototype, and a value carrying them validates only where the schema declares them |
| SCH17 | Happy: an enum without a type | A schema that names only `enum` accepts a member and refuses anything else, including a value of an undeclared shape |
| SCH18 | Bad: a path through a nested value | A failure inside an array or a nested object says where it is (`arguments.cites[1]`, `arguments.project.name`) |
| SCH19 | Sad: a fraction where an integer is wanted | `integer` refuses `1.5` and accepts `2` |
| SCH20 | Bad: a schema nested past the cap | A schema nested more deeply than the cap is refused when it is compiled |

## Typed tools and the loop

A tool is defined with `defineTool`, which compiles its schema once and infers the argument type from it,
so `execute` receives typed arguments and nothing is cast at the tool. The loop checks a call against the
tool's schema before the tool runs, so a tool only ever sees arguments that match what it declared. A tool
made by hand (the testkit's fakes) carries no schema and is not checked, which is why step 2's tests are
unchanged.

| ID | Case | Expected |
|---|---|---|
| TOL01 | Happy: a valid call | A call whose arguments match the schema reaches `execute` with exactly the values the model sent, and the result is saved |
| TOL02 | Sad: an invalid call | The tool's `execute` is never called, and the model gets an error result with `bad_request` and the specific message |
| TOL03 | Sad: the same invalid call again | Three identical refusals in a row park the run as stuck through step 2's safeguard |
| TOL04 | Bad: a schema this build cannot compile | `defineTool` refuses it at definition time, naming the keyword, rather than accepting a tool that can never validate anything |
| TOL05 | Happy: the tool-set hash follows the schema | A changed schema changes the pin, and a reworded description does not |
| TOL06 | Happy: typed arguments without a cast | The inferred type has required properties required and optional ones optional, and an `enum` as a union of its values |
| TOL13 | Bad: a tool that changes state opts in to parallel | `defineTool` refuses `parallel: true` on a tool with an `apply`, because a group's calls read one state, and accepts the same flag on a tool without one |

## State, and how it comes back

Some tools build something as a run goes: the timeline's page, its holds, and its handle map. The record is
the only place that progress lives (decision 32). So a recipe's state is rebuilt by the same call that
would have made it live:

- a pure, deterministic `setup(input)` returns the first user message and the initial state;
- `execute(args, ctx)` may read `ctx.state` but never changes it; its outcome's `details` carry the effect;
- `apply(state, args, outcome)` is the only place state changes, and it returns the next state;
- the core calls `apply` after every successful execute, and again for every saved result during a resume.

One code path, so live and replayed state cannot diverge. The task's input is saved on the `task` message so
that `setup` can run again on a resume, and an input too large for one record entry is `bad_request` at
start.

| ID | Case | Expected |
|---|---|---|
| TOL07 | Happy: effects come from `apply` | A successful call changes the state only through `apply`, and a failed one does not |
| TOL08 | Happy: live and replayed state agree | For any sequence of calls, the state after a live run equals the state rebuilt by replaying its saved results (a property) |
| TOL09 | Bad: a tool that mutates state in `execute` | The live and replayed states differ, which is what the rule's test catches |
| TOL10 | Happy: the same call key twice | A tool that dedupes on `ctx.callKey` changes nothing the second time, and its result says the same thing |
| TOL11 | Sad: a resume never runs `execute` again | A saved result is replayed through `apply` only, with no tool executed |
| TOL12 | Bad: a task input that does not fit | `start` refuses it with `bad_request` and nothing is saved |

## Handles

A handle is a short name such as `c1`, `pr12` or `i34` that the model uses for something exact, so it never
copies a long hash or link (decision 8). The handle table lives inside the recipe's state, so replaying the
saved results rebuilds it exactly.

| ID | Case | Expected |
|---|---|---|
| HND01 | Happy: mint and resolve | `mint("c", target)` returns `c1`, `c2` in order for a kind, each resolving back to its own target, and a listing names them |
| HND02 | Happy: an idempotent mint | Minting the same kind and target again returns the handle it already has, and adds nothing |
| HND03 | Happy: per-kind counters | `c1` and `pr1` both exist, each kind counting from one |
| HND04 | Sad: an unknown handle | A lookup misses and the error text names the handle and the valid ones, capped |
| HND05 | Happy: rebuilt on resume | Replaying the saved results rebuilds a table equal to the live one, and each handle resolves to the same target |
| HND06 | Bad: a hostile handle string | `c1; drop`, a 10 KiB string, `__proto__` and `constructor` are simply unknown, with no prototype pollution |

## Finish and the done-check

`finish` is the shared tool that ends a run, and it is only worth its word when the recipe says what done
means (decision 25). `createFinishTool({ check })` asks the recipe's `check(state, skipped)`; a refusal is an
ordinary error result carrying the message, so the model goes back to work, and repeated refusals count
toward the same-failure total and park the run as stuck. `coverageCheck` builds the message that names what
is missing, sorted and capped, and `skipped` records what the recipe agreed to leave out, each with a
reason. The message reads `not covered yet: 4 issues (i3, i7, i9, i12)`.

| ID | Case | Expected |
|---|---|---|
| FIN01 | Sad: finish before everything is covered | It is refused with the message naming what is missing, the run does not end, and the model is asked again |
| FIN02 | Happy: finish once covered | It is accepted, the run ends `done`, and the result is saved with `done: true` |
| FIN03 | Happy: a skip with a reason | A covered handle left out with a non-empty reason is accepted, and the reason is saved |
| FIN04 | Bad: a skip with no reason | An empty or whitespace-only reason is refused, and the run does not end |
| FIN05 | Sad: a model that cannot satisfy the check | Repeated identical refusals park the run as stuck rather than looping |
| FIN06 | Happy: the coverage message | `coverageCheck` names up to the cap of missing items, says how many there are, and its wording does not depend on their order |

## The recipe

A recipe is a task: `{ name, version, instructions, input, setup, tools, limits?, fallbackModel?, stuck? }`.
`defineRecipe` checks the whole thing when it is defined, so a recipe that could never run is refused at
module load rather than on a person's first day. `maxParallelCalls` says how many of one reply's calls may
run at once (decision 154); it is four by default, and a tool still has to opt in before it joins a group.
`ending` says how the run knows it is done (issue #106, decision 163): `"done-check"` is the default and
means a tool's answer ends it (decision 25), and `"reply"` means the model's own reply is the deliverable,
so a reply with no calls ends the run and nothing nudges it. The two are refused together: a recipe that
ends on its reply cannot also carry a `finish`, because two things would claim to be the ending.

| ID | Case | Expected |
|---|---|---|
| RCP01 | Happy: a valid recipe | Its instructions, tools, limits, fallback and stuck settings reach the run, and its pin covers its tools |
| RCP02 | Bad: duplicate tool names | It is refused when it is defined, naming the tool |
| RCP03 | Bad: a tool with a schema this build cannot compile | It is refused when it is defined, naming the tool and the keyword |
| RCP04 | Bad: a `finish` with no done-check | A tool named `finish` that was not made by `createFinishTool` is refused when the recipe is defined |
| RCP05 | Sad: invalid input at start | `start` returns `bad_request` naming the field, and no run begins |
| RCP06 | Happy: input that is exactly right | `start` accepts it, `setup` turns it into the first message and the state, and the input is saved on the task message |
| RCP07 | Bad: a record resumed under a changed input schema | The saved input is checked against the recipe's schema before `setup` runs, and a mismatch fails with a message saying the input no longer matches, rather than a `TypeError` out of typed recipe code or a state built from the wrong shape |
| RCP08 | Bad: a parallel cap that cannot be honoured | A `maxParallelCalls` that is not a positive whole number is refused when the recipe is defined, and one that can be is kept on the recipe |
| RCP09 | Happy: a recipe that ends on its reply | `ending: "reply"` is kept on the recipe and reaches the run, whose reply then ends it `done`; a recipe that says nothing has no ending of its own, so every existing recipe behaves as it did |
| RCP10 | Bad: a recipe that claims two endings | `ending: "reply"` together with a `finish` tool is refused when the recipe is defined, in a message naming the ending |
| RCP11 | Bad: an ending this build cannot honour | An `ending` that is neither `"reply"` nor `"done-check"` is refused when the recipe is defined, naming the value it was given; a run handed one by hand — a `RunConfig` that never passed through `defineRecipe` — keeps the default ending rather than refusing to start, which is the rule a bad `maxParallelCalls` follows |

## The test recipe, and the scenarios

`timeline-test` is in the testkit: it is generic and fake, with the timeline's shape, so the machinery is
exercised end to end without anything touching the network (decision 60). Its input is a list of repos and
a list of commits (`repo`, `sha`, `message`); `setup` mints `c1..cN` and renders the day, and its tools are
`start_project`, `add_line`, `add_vine`, `mark_continuation` and `finish`. `renderPage` and `renderHandles`
turn its state into strings, which is what the resume test compares.

A scenario file names it with `recipe: timeline-test` and gives the recipe's input as JSON under `input:`. A
scenario without a `recipe` keeps step 1's shape: inline `tools:` and a text `input`, which is what the
loop's own scenarios still use. A `recipe` and `tools` together are refused, so a file cannot say two
things about what runs.

A host brings its own recipe rather than re-implementing the cases in TypeScript against it: `runScenario`
takes a `recipes` map that is consulted before the testkit's own, and `decodeScenario` accepts any recipe
name, because what a file looks like is the file's business and which recipes exist is the host's (issue
#59, SCN06). A name nobody provided throws, naming it and the recipes that were available.

The scenario files are in `scenarios/`: the bad repo from `engineering-practices.md`, a refused then
accepted `finish`, a vine on a missing line, a citation of another repo's commit, and an argument of the
wrong type. `reply-ending.yaml` is a conversation that ends on its reply (SCN10, issue #106), and it is
also the only file whose run has no `finish` at all. The resume row is `RSM07` in
[`limits-and-interruptions.md`](limits-and-interruptions.md).

