# The live suite

`pnpm test:live` calls a real model. It is not part of `pnpm run ci`, it never runs
on a pull request, and every test in it skips, loudly, when its key is missing.

## Running it

```
export OPENCODE_GO_API_KEY=...        # the default provider, an allowance
pnpm test:live                        # one real call with a tool through it

export OPENROUTER_API_KEY=...         # the production-fidelity provider
export OPENROUTER_MODEL=...           # which model, since fidelity is a choice
pnpm test:live

RECORD=1 pnpm test:live               # also write a cassette for CI to replay
```

| Variable              | What it does                                                                                                                     |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCODE_GO_API_KEY` | The key for OpenCode Go, which most live runs use                                                                                |
| `OPENCODE_GO_MODEL`   | Which model to call there. Defaults to `deepseek-v4.1-flash`, which speaks chat completions and stretches the allowance furthest |
| `OPENROUTER_API_KEY`  | The key for OpenRouter, for the small production-fidelity set                                                                    |
| `OPENROUTER_MODEL`    | Required for the OpenRouter case: a model id is a decision, not a default                                                        |
| `RECORD`              | `1` writes the exchange to `cassettes/<provider>-one-tool.json`                                                                  |

## What it costs

OpenCode Go draws on a monthly allowance per model, not a bill, and some models
cost twice as much at certain UTC hours (`docs/engineering-practices.md`), so run
the heavy suites outside those. OpenRouter is real money per call.

Each test sets Lyra's own limits as its cap, so a bad loop cannot run away: four
steps, 20,000 tokens, 120 seconds, and a 30-second deadline on a tool. A run that
parks on a limit is a pass for the adapter (it was told to stop), and only `failed`
or a thrown exception fails the test.

## What it will not do

- Print a key, or an `Authorization` header, or put one in an error.
- Write a cassette that holds one: the recorder runs the same scan CI runs and
  refuses the file.
- Reach the network from the cassette replay in `pnpm test`. A recording replays
  with no network, which is the point of committing it.

## Where it lives

Under `packages/lyra/live/`, outside `src/`, because it needs `node:fs` and the
environment, which `importcheck` refuses in the package. It is never published, it
is excluded from the build and from coverage, and it has its own `tsconfig.json`
and its own Vitest config (`vitest.live.config.ts`) so it cannot leak into the gate.
