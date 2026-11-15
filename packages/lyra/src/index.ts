/**
 * The core entry point.
 *
 * Nothing is built yet, and that is on purpose. This file exists so the gate
 * (`pnpm ci`) has an empty core to pass against before the first line of
 * feature code, as `docs/first-slice.md` step 1 describes. The loop, recipes,
 * tools, limits, and record arrive here test-first.
 *
 * Everything in this entry point uses web-standard APIs only. No `node:*`
 * imports, so the same code runs on Cloudflare Workers and on Node
 * (`docs/decisions.md`, decisions 12 and 13).
 */

export {};
