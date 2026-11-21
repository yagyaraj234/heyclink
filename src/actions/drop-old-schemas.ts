import pg from "pg";

/** `pnpm test` global setup: drops throwaway store schemas (`t_<ms>_<id>`, see openStore) from runs over an hour old.
 * Recent ones stay, because another worktree may be testing against the same database right now. */
export async function globalSetup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const cutoff = Date.now() - 3_600_000;
    const { rows } = await db.query<{ name: string }>(String.raw`SELECT nspname AS name FROM pg_namespace WHERE nspname ~ '^t_(\d+_)?[0-9a-f]+$'`);
    for (const { name } of rows) {
      const created = /^t_(\d+)_/.exec(name)?.[1];
      if (!created || Number(created) < cutoff) await db.query(`DROP SCHEMA ${name} CASCADE`); // no time: the old t_<uuid> names
    }
  } finally {
    await db.end();
  }
}
