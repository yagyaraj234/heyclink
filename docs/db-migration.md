# SQLite to Neon Postgres

There was no deployment and there were no customers, so this was a replacement, not a migration. No data was copied. SQLite and `node:sqlite` are gone.

## What changed

- **Driver:** `pg`, the only new dependency. It's the standard Postgres client, with no ORM.
- **Config:**
  - `DATABASE_URL` is required. On Neon, use the pooled string (`-pooler` host).
  - `PG_POOL_MAX` sets connections per instance (default 5).
  - `DATA_DIR` is removed.
- **Schema:** the same tables as before, created at startup with `CREATE TABLE IF NOT EXISTS` inside `pg_advisory_xact_lock`. Instances that start together don't race.
- **Store:** the methods are the same as before but return promises. Every caller awaits them.

## Decisions

| Choice | Why |
|---|---|
| JSON stays in `text` columns, not `jsonb` | `jsonb` reorders keys. `cartRevision` is a sha256 of `JSON.stringify(cart)`, so a reordered cart would look changed. Queries cast with `data::jsonb`. |
| `at` stays ISO text, compared with `COLLATE "C"` | Same ordering as SQLite, with no conversion code. |
| `seq bigint GENERATED ALWAYS AS IDENTITY` | Replaces `rowid` for newest-first ordering. |
| One schema SQL string, no numbered migrations | There's nothing to upgrade yet. Add migrations with the first schema change after launch. |
| Tests use a throwaway schema per store on `TEST_DATABASE_URL` | Files run in parallel without sharing state. CI runs a `postgres:17` service. |

## Multiple instances

| Risk | Fix |
|---|---|
| The scheduler runs on every instance | `claimOrder` locks the action row (`FOR UPDATE`) and sets `placing` in one transaction, so only one instance checks out a due order. Test: two stores on one database, `runDue` on both, and the fake Swiggy client sees one checkout. The test fails when the lock is removed. |
| Concurrent writers | `finishOrder`, `confirmPurchase` and `confirmOrder` run in a transaction that locks the action and household rows. |
| Read, modify, write on household history | Covered by the household row lock above. |
| Alert delivery on every instance | The lease is a conditional `UPDATE ... WHERE due <= now`, so only one instance sends each alert. |
| Dropped idle connections (Neon) | `pool.on("error")` logs instead of crashing. The connect timeout is 15 s to cover a free-tier cold start. |

## Not done, and why

- **Instamart OAuth tickets and sessions stay in memory** (`src/actions/instamart.ts`). A callback that lands on a different instance fails. Instamart is staging-only. Move them to tables before running more than one instance with Instamart on.
- **Some `app.ts` routes read a card, change it and save it across awaits.** SQLite was synchronous in one process, so that was atomic. Now two concurrent edits to the same card can lose one. It's rare: one owner, one card. The fix is a `tx` plus `lockedAction` in those routes.
- **Interrupted-checkout recovery assumes one checkout runner.** At boot, `recoverInterruptedOrders` fails every order still marked `placing`. A second instance that boots while another is mid-checkout would fail that order. To scale out, store a claim time and only expire old claims.
- **Optimistic `version` on households and retry with 409.** The row locks cover the paths that write history.
- **Test schemas aren't dropped.** They're harmless in a local or CI database.

## Neon free tier

- Singapore region.
- The 60 s scheduler keeps the compute awake. Check the monthly compute-hour allowance. If it runs out, slow the interval or move to a paid plan.
