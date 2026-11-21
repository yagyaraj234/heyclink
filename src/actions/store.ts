import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import pg from "pg";
import type { InstamartIntent } from "./instamart-intent.ts";
import { purchasedQuantity, reviewOf } from "./cart.ts";
import type { ReviewedLine } from "./cart.ts";
import { AUTH_SCHEMA, openHouseholdAuth } from "./auth-store.ts";
import { ALERTS_SCHEMA, openAlerts } from "./alerts.ts";
import type { ActionCard, CallResult, Cart, GroceryLine, Household, MealChoice, Unit } from "../contracts.ts";
import householdJson from "../../fixtures/household.json" with { type: "json" };

/** Fixed join code for the seeded fixture household, so the cook role can be demoed on h1. */
export const DEMO_CODE = "TADKA2";

export type ReceiptLine = Household["history"][number]["lines"][number] & {
  pack: {count: number; size: number; unit: Unit};
  price?: number;
};
export interface GroceryReceipt {
  receiptId: string;
  source: "manual" | "instamart";
  lines: ReceiptLine[];
  total?: string;
  fees?: {label: string; value: string}[];
  address?: string;
  eta?: string;
}

export const cartRevision = (cart: Cart) => createHash("sha256").update(JSON.stringify(cart)).digest("hex");
// done = approved (cart/advance) or answered (question). cartId links ingredient questions to a standalone meal cart.
// choices = per question option, the line it adds to the cart (null = adds nothing). at = when addAction stored it.
// placing = when an order checkout started (see placeOrder); a stale one is abandoned.
export type Entry = {
  card: ActionCard; householdId: string; callId?: string; done: boolean; cartId?: string; choices?: (GroceryLine | null)[]; heldIndex?: number; placing?: string; at?: string;
  refreshedBill?: boolean;
  selectedMeal?: MealChoice;
  tracking?: { state?: "ordered" | "delivered"; remindAt?: string; deliveredAt?: string; receipt?: GroceryReceipt };
};
/** call.actions is rebuilt from the action rows, so a card edited through its Entry shows up in the call. */
export type StoredCall = { call: CallResult; at: string; entries: Entry[] };

export function manualReceipt(cart: Cart): GroceryReceipt {
  const lines = cart.lines.map(line => {
    const { pack = {count: 1, size: line.qty, unit: line.unit} } = line as Partial<ReviewedLine>;
    return { item: line.item, qty: pack.count * pack.size, unit: pack.unit, pack, price: line.price,
      ...(line.brand && {brand: line.brand}) };
  });
  return { source: "manual", lines, total: `₹${cart.total}`, receiptId: cartRevision(cart) };
}
export function historyLines(receipt: GroceryReceipt): Household["history"][number]["lines"] {
  return receipt.lines.map(({item,qty,unit,brand}) => ({item,qty,unit,...(brand && {brand})}));
}

export type Query = <R extends pg.QueryResultRow = Row>(sql: string, ...args: unknown[]) => Promise<pg.QueryResult<R>>;
export type Tx = <T>(fn: () => Promise<T>) => Promise<T>;
type Row = { data: string };

// JSON stays as text: jsonb reorders keys, and cartRevision hashes the serialized cart.
// ISO timestamps compare as text, so their comparisons use COLLATE "C".
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS households (id text PRIMARY KEY, code text NOT NULL UNIQUE, data text NOT NULL);
  CREATE TABLE IF NOT EXISTS owner_keys (household text PRIMARY KEY, hash text NOT NULL);
  CREATE TABLE IF NOT EXISTS instamart_prepared (cart text PRIMARY KEY, revision text NOT NULL, intent text, receipt text, read_token text, review_revision text);
  CREATE TABLE IF NOT EXISTS instamart_links (household text PRIMARY KEY, sealed text NOT NULL);
  CREATE TABLE IF NOT EXISTS instamart_state (id text PRIMARY KEY, value text NOT NULL, until bigint NOT NULL);
  CREATE TABLE IF NOT EXISTS calls (seq bigint GENERATED ALWAYS AS IDENTITY, id text PRIMARY KEY, household text NOT NULL, at text NOT NULL, data text NOT NULL);
  CREATE TABLE IF NOT EXISTS actions (seq bigint GENERATED ALWAYS AS IDENTITY, id text PRIMARY KEY, household text NOT NULL, call text, pos integer NOT NULL, data text NOT NULL);
  CREATE TABLE IF NOT EXISTS usage_samples (
    seq bigint GENERATED ALWAYS AS IDENTITY, household text NOT NULL, receipt text NOT NULL, item text NOT NULL,
    qty double precision NOT NULL, unit text NOT NULL, days double precision NOT NULL, PRIMARY KEY (receipt, item)
  );
  CREATE INDEX IF NOT EXISTS samples_by_household ON usage_samples (household, item);
  CREATE INDEX IF NOT EXISTS calls_household ON calls (household);
  CREATE INDEX IF NOT EXISTS actions_call ON actions (call, pos);
  CREATE INDEX IF NOT EXISTS actions_household ON actions (household);
`;

/**
 * Households, calls and actions as JSON rows in Postgres.
 * `url` set: that database's default schema (production, DATABASE_URL).
 * `url` unset: a fresh schema on TEST_DATABASE_URL, or `schema` to reopen one (tests).
 */
export async function openStore({ url, schema }: { url?: string; schema?: string } = {}) {
  if (!url) {
    url = process.env.TEST_DATABASE_URL;
    if (!url) throw new Error("Set TEST_DATABASE_URL to a Postgres you can create schemas in (see README)");
    // The creation time lets drop-old-schemas.ts drop schemas from old runs.
    schema ??= `t_${Date.now()}_${randomUUID().slice(0, 8)}`;
    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    try { await admin.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`); } finally { await admin.end(); }
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.PG_POOL_MAX) || 5,
    connectionTimeoutMillis: 15_000, // a suspended free-tier Neon compute takes a few seconds to wake
    query_timeout: 10_000,
    allowExitOnIdle: true,
    // Tests open hundreds of stores and never close them; drop idle connections fast so they stay under max_connections.
    ...(schema && { options: `-c search_path=${schema}`, idleTimeoutMillis: 100 }),
  });
  pool.on("error", (err) => console.error("Postgres idle client error:", err.message)); // Neon drops idle connections

  // A transaction pins one pooled client; every query inside fn uses it through this.
  const current = new AsyncLocalStorage<pg.PoolClient>();
  const q: Query = (sql, ...args) => (current.getStore() ?? pool).query(sql, args);
  const tx: Tx = async (fn) => {
    if (current.getStore()) return fn();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const result = await current.run(client, fn);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };
  const one = async <T>(sql: string, ...args: unknown[]) => {
    const row = (await q(sql, ...args)).rows[0];
    return row && (JSON.parse(row.data) as T);
  };
  const many = async <T>(sql: string, ...args: unknown[]) => (await q(sql, ...args)).rows.map(r => JSON.parse(r.data) as T);
  type CallRow = Row & { at: string };
  const toStored = async (row: CallRow): Promise<StoredCall> => {
    const call = JSON.parse(row.data) as CallResult;
    const entries = await many<Entry>("SELECT data FROM actions WHERE call = $1 ORDER BY pos, seq", call.callId);
    return { call: { ...call, actions: entries.map((e) => e.card) }, at: row.at, entries };
  };
  const conflict = (message: string) => Object.assign(new Error(message), {status: 409});

  // Instances starting together create the tables once.
  await tx(async () => {
    await q("SELECT pg_advisory_xact_lock(7262)");
    await q(SCHEMA + ALERTS_SCHEMA + AUTH_SCHEMA);
  });

  const alerts = openAlerts(q, tx);
  const store = {
    alerts,
    auth: openHouseholdAuth(q, tx),
    schema,
    /** Runs fn in one transaction; lockedAction/lockedHousehold inside it hold their rows until it ends. */
    tx,
    /** Ends the pool. `drop` also removes a test schema. */
    async close({ drop = false } = {}) {
      if (drop && schema) await q(`DROP SCHEMA ${schema} CASCADE`);
      await pool.end();
    },
    household: (id: string) => one<Household>("SELECT data FROM households WHERE id = $1", id),
    householdByCode: (code: string) => one<Household>("SELECT data FROM households WHERE code = $1", code),
    /** false when the code is already taken; the caller picks another. */
    addHousehold: (h: Household, code: string, token?: string) => tx(async () => {
      const added = (await q("INSERT INTO households (id, code, data) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING", h.id, code, JSON.stringify(h))).rowCount === 1;
      if (added && token) await q("INSERT INTO owner_keys VALUES ($1, $2)", h.id, createHash("sha256").update(token).digest("hex"));
      return added;
    }),
    revokeOwnerKey: async (id: string) => void await q("DELETE FROM owner_keys WHERE household = $1", id),
    hasOwnerKey: async (id: string) => !!(await q("SELECT 1 FROM owner_keys WHERE household = $1", id)).rowCount,
    linkedInstamart: async (id: string) =>
      (await q<{sealed: string}>("SELECT sealed FROM instamart_links WHERE household = $1", id)).rows[0]?.sealed,
    saveInstamartLink: async (id: string, sealed: string) =>
      void await q("INSERT INTO instamart_links VALUES ($1, $2) ON CONFLICT (household) DO UPDATE SET sealed = excluded.sealed", id, sealed),
    // Instamart OAuth tickets, sessions and leases, shared by every instance. A row past `until` (epoch ms) is gone.
    instamartState: async (id: string) =>
      (await q<{value: string}>("SELECT value FROM instamart_state WHERE id = $1 AND until > $2", id, Date.now())).rows[0]?.value,
    saveInstamartState: async (id: string, value: string, until: number) =>
      void await q("INSERT INTO instamart_state VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET value = excluded.value, until = excluded.until", id, value, until),
    /** false while another live row holds id. */
    claimInstamartState: async (id: string, value: string, until: number) =>
      (await q("INSERT INTO instamart_state VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET value = excluded.value, until = excluded.until WHERE instamart_state.until <= $4",
        id, value, until, Date.now())).rowCount === 1,
    /** Deletes the row (only if it still holds `value`, when given) and returns its value, so one taker on any instance gets it. Also clears expired rows. */
    takeInstamartState: async (id: string, value?: string) => {
      await q("DELETE FROM instamart_state WHERE until <= $1", Date.now());
      return (await q<{value: string}>("DELETE FROM instamart_state WHERE id = $1 AND ($2::text IS NULL OR value = $2) RETURNING value", id, value ?? null)).rows[0]?.value;
    },
    // Keep the claim after an upstream timeout: a repeat could add the same packs twice.
    claimInstamart: async (cart: string, revision: string, intent?: InstamartIntent) =>
      (await q("INSERT INTO instamart_prepared (cart, revision, intent) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
        cart, revision, intent ? JSON.stringify(intent) : null)).rowCount === 1,
    instamartIntent: (cart: string) => one<InstamartIntent>("SELECT intent AS data FROM instamart_prepared WHERE cart = $1 AND intent IS NOT NULL", cart),
    async saveInstamartIntent(cart: string, intent: InstamartIntent) {
      await q("UPDATE instamart_prepared SET intent = $1, receipt = NULL, read_token = NULL, review_revision = NULL WHERE cart = $2", JSON.stringify(intent), cart);
    },
    instamartReceipt: (cart: string, revision: string) =>
      one<GroceryReceipt>("SELECT receipt AS data FROM instamart_prepared WHERE cart = $1 AND COALESCE(review_revision, revision) = $2 AND receipt IS NOT NULL", cart, revision),
    async beginInstamartReview(cart: string, revision: string) {
      const token = randomUUID();
      const entry = await store.action(cart);
      if (!entry || entry.done || entry.card.type !== "cart" || cartRevision(entry.card.cart) !== revision ||
          !(await q("UPDATE instamart_prepared SET receipt = NULL, read_token = $1, review_revision = $2 WHERE cart = $3", token, revision, cart)).rowCount)
        throw conflict("Cart changed. Reopen the current review.");
      return token;
    },
    isInstamartReviewCurrent: async (cart: string, revision: string, token: string) =>
      !!(await q("SELECT 1 FROM instamart_prepared WHERE cart = $1 AND review_revision = $2 AND read_token = $3", cart, revision, token)).rowCount,
    async saveInstamartReceipt(cart: string, revision: string, receipt: Omit<GroceryReceipt, "receiptId">, token?: string) {
      const entry = await store.action(cart);
      if (!entry || entry.done || entry.card.type !== "cart" || cartRevision(entry.card.cart) !== revision ||
          !receipt.lines.length || receipt.source !== "instamart") throw conflict("Cart changed. Review in Instamart again.");
      const encoded = JSON.stringify(receipt);
      const receiptId = createHash("sha256").update(revision).update(encoded).digest("hex");
      const saved = await q("UPDATE instamart_prepared SET receipt = $1 WHERE cart = $2 AND COALESCE(review_revision, revision) = $3 AND read_token IS NOT DISTINCT FROM $4",
        JSON.stringify({...receipt, receiptId}), cart, revision, token ?? null);
      if (!saved.rowCount) throw conflict("Instamart claim changed.");
    },
    instamartClaimed: async (cart: string) =>
      (await q<{revision: string}>("SELECT revision FROM instamart_prepared WHERE cart = $1", cart)).rows[0]?.revision,
    async isOwner(id: string, authorization: string | undefined): Promise<boolean> {
      const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
      return !!token && !!(await q("SELECT 1 FROM owner_keys WHERE household = $1 AND hash = $2",
        id, createHash("sha256").update(token).digest("hex"))).rowCount;
    },
    saveHousehold: async (h: Household) => void await q("UPDATE households SET data = $1 WHERE id = $2", JSON.stringify(h), h.id),

    /** Stores the call; its cards are stored separately with addAction. */
    async addCall(call: CallResult, householdId: string, at: string) {
      const extraction = call.extraction as typeof call.extraction & {stockouts?: string[]};
      for (const item of extraction.stockouts ?? []) {
        const receipt = (await q<{id: string; data: string}>(`SELECT id, data FROM actions
          WHERE household = $1 AND data::jsonb #>> '{tracking,state}' = 'delivered'
          AND (data::jsonb #>> '{tracking,deliveredAt}') COLLATE "C" <= $2 AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(data::jsonb #> '{tracking,receipt,lines}', CASE WHEN NOT EXISTS (
              SELECT 1 FROM instamart_prepared WHERE cart = actions.id) THEN data::jsonb #> '{card,cart,lines}' END)) AS line
            WHERE line ->> 'item' = $3)
          ORDER BY (data::jsonb #>> '{tracking,deliveredAt}') COLLATE "C" DESC LIMIT 1`, householdId, at, item)).rows[0];
        if (!receipt) continue;
        const entry: Entry = JSON.parse(receipt.data);
        if (entry.card.type !== "cart") continue;
        const bought = historyLines(entry.tracking?.receipt ?? manualReceipt(entry.card.cart)).filter(l => l.item === item);
        const quantity = purchasedQuantity(bought);
        if (!quantity) continue;
        const days = (Date.parse(at) - Date.parse(entry.tracking!.deliveredAt!)) / 86_400_000;
        await q("INSERT INTO usage_samples (household, receipt, item, qty, unit, days) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING",
          householdId, receipt.id, item, quantity.qty, quantity.unit, days);
      }
      const items = [...new Set(extraction.groceries.map(l => l.item))];
      const usage = (await Promise.all(items.map(async item => (await q(`SELECT item, qty, unit,
          round(avg(days)::numeric, 1)::float8 AS days, count(*)::int AS samples
        FROM usage_samples WHERE household = $1 AND item = $2 GROUP BY item, qty, unit ORDER BY max(seq) DESC LIMIT 1`, householdId, item)).rows))).flat();
      await q("INSERT INTO calls (id, household, at, data) VALUES ($1, $2, $3, $4)", call.callId, householdId, at, JSON.stringify({
        ...call, ...(usage.length && {usage}), actions: [],
      }));
    },
    callHousehold: async (id: string) => (await q<{ household: string }>("SELECT household FROM calls WHERE id = $1", id)).rows[0]?.household,
    async call(id: string): Promise<StoredCall | undefined> {
      const row = (await q<CallRow>("SELECT data, at FROM calls WHERE id = $1", id)).rows[0];
      return row && toStored(row);
    },
    /** Newest → oldest, all of them or the last `limit`. ponytail: one query per call; fine at demo sizes. */
    calls: async (householdId: string, limit?: number) =>
      Promise.all((await q<CallRow>("SELECT data, at FROM calls WHERE household = $1 ORDER BY seq DESC LIMIT $2", householdId, limit ?? null)).rows.map(toStored)),

    action: (id: string) => one<Entry>("SELECT data FROM actions WHERE id = $1", id),
    /** Appends the card to its call's actions, or puts it first. */
    async addAction(e: Entry, { first = false } = {}) {
      const pos = first ? "COALESCE(MIN(pos), 0) - 1" : "COALESCE(MAX(pos), 0) + 1";
      if (e.card.type === "cart" && e.callId && e.card.cart.lines.length && await alerts.hasDevice(e.householdId)) {
        const call = await one<CallResult & { extraction: { neededBy?: string } }>("SELECT data FROM calls WHERE id = $1", e.callId);
        const reminder = Date.parse(call?.extraction.neededBy ?? "") - 30 * 60_000;
        if (reminder > Date.now()) {
          e.tracking = {...e.tracking, remindAt: new Date(reminder).toISOString()};
          await alerts.queue(e.householdId, e.card.id, "reminder", reminder);
        }
      }
      await q(`INSERT INTO actions (id, household, call, pos, data)
        SELECT $1::text, $2::text, $3::text, ${pos}, $4::text FROM actions WHERE call IS NOT DISTINCT FROM $3::text`,
        e.card.id, e.householdId, e.callId ?? null, JSON.stringify({ ...e, at: new Date().toISOString() }));
      if (e.card.type === "cart" && e.callId && e.card.cart.lines.length) await alerts.queue(e.householdId, e.card.id, "ready", Date.now());
    },
    /** Confirmed orders that can start now, including immediate orders interrupted before claiming. */
    dueOrders: (now: string) =>
      many<Entry>(`SELECT data FROM actions WHERE data::jsonb #>> '{card,type}' = 'order'
        AND data::jsonb #>> '{card,order,status}' = 'scheduled' AND (data::jsonb ->> 'done')::boolean
        AND data::jsonb ->> 'placing' IS NULL
        AND (data::jsonb #>> '{card,order,scheduledFor}' IS NULL OR (data::jsonb #>> '{card,order,scheduledFor}') COLLATE "C" <= $1)`, now),
    /** Cards with no call (meal plans, the carts they make), newest first. */
    looseActions: (householdId: string) =>
      many<Entry>("SELECT data FROM actions WHERE household = $1 AND call IS NULL ORDER BY seq DESC", householdId),
    saveAction: async (e: Entry) => void await q("UPDATE actions SET data = $1 WHERE id = $2", JSON.stringify(e), e.card.id),

    // Locks the row until the transaction ends, so concurrent writers on other instances wait.
    lockedAction: (id: string) => one<Entry>("SELECT data FROM actions WHERE id = $1 FOR UPDATE", id),
    lockedHousehold: (id: string) => one<Household>("SELECT data FROM households WHERE id = $1 FOR UPDATE", id),

    confirmOrder: (id: string) => tx(async () => {
      const entry = (await store.lockedAction(id))!;
      if (!entry.done) {
        entry.done = true;
        await store.saveAction(entry);
      }
      return entry;
    }),
    /** true for the one caller that gets to place this order. */
    claimOrder: (id: string, at: string) => tx(async () => {
      const entry = await store.lockedAction(id);
      if (!entry?.done || entry.card.type !== "order" || entry.card.order.status !== "scheduled" || entry.placing) return false;
      entry.placing = at;
      await store.saveAction(entry);
      return true;
    }),
    finishOrder(entry: Entry) {
      if (entry.card.type !== "order") throw new Error("Expected an order");
      return tx(async () => {
        const current = await store.lockedAction(entry.card.id);
        if (current?.card.type === "order" && current.placing && current.card.order.status === "scheduled") {
          // Pre-review orders already updated household history when their source cart was approved.
          if (entry.card.type === "order" && entry.card.order.status === "placed" && !current.refreshedBill && reviewOf(current.card.order.cart).reviewId) {
            const household = (await store.lockedHousehold(entry.householdId))!;
            household.history.push({at: new Date().toISOString().slice(0,10), lines: historyLines(manualReceipt(entry.card.order.cart))});
            await store.saveHousehold(household);
          }
          delete entry.placing;
          await store.saveAction(entry);
        }
      });
    },

    confirmPurchase(entry: Entry, receipt: GroceryReceipt) {
      if (entry.card.type !== "cart") throw new Error("Expected a grocery cart");
      return tx(async () => {
        const current = await store.lockedAction(entry.card.id);
        if (!current || current.card.type !== "cart" || entry.card.type !== "cart" || cartRevision(current.card.cart) !== cartRevision(entry.card.cart) ||
            current.tracking?.state === "delivered" || (current.done && current.tracking?.receipt?.receiptId !== receipt.receiptId) ||
            (!current.done && receipt.source === "instamart" &&
             (await store.instamartReceipt(entry.card.id, cartRevision(current.card.cart)))?.receiptId !== receipt.receiptId)) {
          throw conflict("Purchase changed. Review it again.");
        }
        if (!current.done) {
          const household = (await store.lockedHousehold(entry.householdId))!;
          household.history.push({at: new Date().toISOString().slice(0,10), lines: historyLines(receipt)});
          await store.saveHousehold(household);
        }
        entry.done = true;
        await store.saveAction(entry);
      });
    },

    /** Fails orders whose checkout started before `before` and never finished: the instance running it died,
     * and the attempt may have reached the provider, so it is never retried.
     * ponytail: a checkout that outlives the cutoff and then succeeds stays "failed"; the Swiggy client times out after 15 s. */
    failAbandonedCheckouts: (before: string) => tx(async () => {
      // Edited in JS, not jsonb_set, so the stored JSON keeps its key order (cart revisions hash it).
      for (const e of await many<Entry>(`SELECT data FROM actions WHERE data::jsonb #>> '{card,type}' = 'order'
          AND data::jsonb #>> '{card,order,status}' = 'scheduled' AND (data::jsonb ->> 'placing') COLLATE "C" < $1 FOR UPDATE`, before)) {
        if (e.card.type !== "order") continue;
        e.card.order.status = "failed";
        delete e.placing;
        await store.saveAction(e);
      }
    }),

    /** Drops the fixture household's calls and actions and restores its fixture data. */
    resetDemo: () => tx(async () => {
      await q("DELETE FROM usage_samples WHERE household = $1", householdJson.id);
      await q("DELETE FROM calls WHERE household = $1", householdJson.id);
      await q("DELETE FROM actions WHERE household = $1", householdJson.id);
      await store.saveHousehold(householdJson as Household);
    }),
  };
  await store.addHousehold(householdJson as Household, DEMO_CODE); // no-op once seeded
  return store;
}
export type Store = Awaited<ReturnType<typeof openStore>>;
