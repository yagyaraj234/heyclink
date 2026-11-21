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
| Tests use a throwaway schema per store on `TEST_DATABASE_URL` | Files run in parallel without sharing state. CI runs a `postgres:17` service. Schemas are named `t_<ms>_<id>`, and `drop-old-schemas.ts` (the `pnpm test` global setup) drops ones over an hour old. It doesn't drop newer ones, because another worktree may be testing against the same database. |

## Multiple instances

| Risk | Fix |
|---|---|
| The scheduler runs on every instance | `claimOrder` locks the action row (`FOR UPDATE`) and sets `placing` in one transaction, so only one instance checks out a due order. Test: two stores on one database, `runDue` on both, and the fake Swiggy client sees one checkout. The test fails when the lock is removed. |
| Concurrent writers | `finishOrder`, `confirmPurchase` and `confirmOrder` run in a transaction that locks the action and household rows. |
| Read, modify, write in `app.ts` routes | `/review`, `/tracking`, `/approve` and `/answer` run inside `store.tx`, holding the card's row lock, then its cart's, then the household's. An edit on another instance waits instead of overwriting. STT and checkout run outside the transaction, so the order claim commits before Swiggy is called. Test: two instances answer 8 meal plans at once, and each answer is counted once. |
| An instance dies mid-checkout | `placing` holds the claim time. Every `runDue` fails claims older than 10 minutes, so a checkout still running on another instance is left alone. The order is never retried, because the attempt may have reached Swiggy. |
| Instamart OAuth steps landing on different instances | Tickets, sessions, the per-household update lease and the registered `client_id` live in `instamart_state`. A row's id is a sha256 of the browser secret and its payload is sealed with a key derived from that secret, so the database alone can't read a session or unlock a credential. Each instance caches its live provider connection and reconnects from the session's token when a request lands somewhere new. Tickets are taken with `DELETE ... RETURNING`, so a link opens once. Test: open on B, callback on A, addresses on B, packs on A, prepare on B; one registration. The `client_id` row never expires; if Swiggy drops the registration, run `DELETE FROM instamart_state WHERE id LIKE 'client %'` and the next login registers again. |
| Alert delivery on every instance | The lease is a conditional `UPDATE ... WHERE due <= now`, so only one instance sends each alert. |
| Dropped idle connections (Neon) | `pool.on("error")` logs instead of crashing. The connect timeout is 15 s to cover a free-tier cold start. |

## Not done, and why

- **Two tabs of one Instamart session write last-wins.** Each request saves the whole session row. Only the same browser cookie can race itself, and the worst case is a stale CSRF token that asks for a reload.
- **Optimistic `version` on households and retry with 409.** Not needed: every path that writes a household or a card holds its row lock.

## Neon free tier

- Singapore region.
- The 60 s scheduler keeps the compute awake. Check the monthly compute-hour allowance. If it runs out, slow the interval or move to a paid plan.
