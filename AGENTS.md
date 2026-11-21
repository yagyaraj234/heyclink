# voice-for-india

A household kitchen app. The owner signs up and registers their cook. The cook sends voice notes or text (Hindi/Hinglish, Telugu stretch goal) from the app. Out come actions: a grocery cart (Instamart order, now or scheduled), a UPI link and an advance approval card, and tomorrow's meal plan (cook or order, from habits and fitness goals), all resolved against household memory.
Hackathon build. Code freeze is Sun 2026-11-22 2 PM IST. Feature freeze is Sat 11 PM, and regression runs at 1 AM.

## Commands
- `pnpm check`: typecheck plus all tests. It must pass before every commit.
- `pnpm test`: `node --test`. Test files are `*.test.ts` next to the code. Needs a Postgres: put `TEST_DATABASE_URL` in `.env.test` (e.g. `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:17`).
- `pnpm test:live`: opt-in tests that hit real APIs (need `LIVE=1` and keys). They never run in CI.
- `pnpm dev`: Express server on `$PORT` (default 3000). Needs `DATABASE_URL`.

## Runtime rules (Node 26 native TypeScript; no build step)
- Relative imports use the `.ts` extension: `import { x } from "./x.ts"`.
- Type-only imports use `import type`.
- No `enum`, `namespace` or constructor parameter properties. Use `as const` arrays plus a union type (see `src/contracts.ts`).
- No new dependency without a one-line reason in the PR. Prefer stdlib and `fetch`.

## Lanes (one worktree and branch each; touch only your folder)
| Lane | Folder | Owns |
|---|---|---|
| 1 pipeline | `src/pipeline/` | STT adapters (openai gpt-transcribe, sarvam saaras:v4, whisper.cpp), extraction via OpenAI structured outputs, resolver against `Household` |
| 2 actions | `src/actions/`, `src/server.ts`, `src/app.ts` | mock catalog, search links, Instamart orders (own-account OAuth, COD), scheduler, UPI link/QR, advance approval, memory updates, signup and Postgres storage (`pg`, Neon), Express routes |
| 3 indic | `src/indic/` | lexicon (Devanagari/roman → canonical item id), quantity normalizer (paav, aadha, dedh, dhai, saade, number words, packet, darjan, gaddi), fuzzy matching |
| 4 eval | `eval/` | dataset loaders, scorer, baselines, ablation, results table |
| 5 web | `web/` | Vite + React thread UI (frozen for the demo; new UI goes in `mobile/`) |
| 6 mobile | `mobile/` | Expo app. Owner: signup, add cook, cards feed, approvals, meal plan. Cook: record or type, then send to `POST /calls`. A role switch lets one phone demo both. |

`src/contracts.ts` and `fixtures/` are **frozen**. `fixtures/items.json` is the canonical item-id list: lexicon outputs, catalog keys and extraction `item` values must all be ids from it. If a lane needs a change, stop and ask the integrator. Never edit them inside a lane PR.
If a lane needs another lane's function before it exists, stub it locally in your own folder behind the contract type, and note that in the PR.

## TDD (mandatory)
- Red, then green. Write one failing test first, then only enough code to pass it. One vertical slice per cycle.
- Test **only at the confirmed seams** below. Never test private helpers.
- Expected values come from an independent source (fixtures gold, hand-written literals, the spec). Never recompute them the way the code does.
- Fakes are allowed **only** for the `Stt` and `Llm` ports and the network. Never mock your own modules.
- Refactoring happens in review (`/simplify`), not inside the loop.

### Confirmed seams
| Lane | Seam | How |
|---|---|---|
| indic | `normalizeQuantity(raw) → { qty, unit } \| null`, `resolveItem(raw) → string \| null` | pure functions, table-driven, hand-written literals (`"dedh kilo"` → 1.5 kg, `"do gaddi"` → 2 bunch) |
| pipeline | `processCall(input, household, { stt, llm }) → Promise<CallResult>` | fake `Stt`/`Llm` ports only; gold from `fixtures/cases`; result must include `timings` |
| actions | `planActions(extraction, household) → ActionCard[]`, `buildCart(lines, household) → Promise<Cart>` | real mock catalog; asserts approval limit, UPI link, advance card |
| actions | HTTP `POST /calls`, `POST /actions/:id/approve`, `POST /households` | `app.listen(0)` + `fetch` against the real app with fake ports injected |
| actions | `runDue(now, store, swiggy) → Order[]` | real Postgres (a throwaway schema per store on `TEST_DATABASE_URL`), fake Swiggy client (network); places due scheduled orders exactly once |
| pipeline | `planMeals(household, date, { llm }) → Promise<MealPlan>` | fake `Llm`; asserts `suggested` from habits, cart excludes pantry items, diet respected |
| mobile | none | UI only; behavior lives behind the server seams |
| eval | `scoreExtraction(gold, pred)`, `summarizeLatency(ms[]) → LatencySummary` | pure; latency expected values hand-computed (nearest-rank percentile) |
| any | one `LIVE=1` test per real adapter | skipped unless `LIVE=1`; never in CI. The Swiggy LIVE test never calls `checkout` (no cancel tool, real money). |

Latency is a first-class metric: report p50/p95/p99 of `timings.totalMs` (agent response latency) and per stage, per provider, in the eval table.

## Workflow per lane
plan → build (TDD) → `pnpm check` green → fix → optimize → `pnpm check` → push branch → `gh pr create` against `main` → the user reviews and merges. Never merge yourself. Never push to `main`.

## Git
- Never add AI or agent attribution anywhere: no `Co-authored-by`, "Generated with" or similar trailers in commits, PRs or tags. Write messages as the user would.
- Small commits, imperative subject (`pipeline: add sarvam adapter`).
- The repo is public. Never commit `.env`, keys, audio of real people or `eval/data/`.

## Definition of done (per PR)
`pnpm check` is green locally and in CI. New behavior has a test at a confirmed seam. There is no `any` without a comment. The PR body says what was cut and why.
