import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { ActionCard, CallResult, GroceryLine, Household } from "../contracts.ts";
import householdJson from "../../fixtures/household.json" with { type: "json" };

/** Fixed join code for the seeded fixture household, so the cook role can be demoed on h1. */
export const DEMO_CODE = "TADKA2";

// done = approved (cart/advance) or answered (question). lines = what the cart is built from.
// choices = per question option, the line it adds to the cart (null = adds nothing).
// placing = an order checkout is in flight (see placeOrder).
export type Entry = {
  card: ActionCard; householdId: string; callId?: string; done: boolean; lines?: GroceryLine[]; choices?: (GroceryLine | null)[]; placing?: boolean;
};
/** call.actions is rebuilt from the action rows, so a card edited through its Entry shows up in the call. */
export type StoredCall = { call: CallResult; at: string; entries: Entry[] };

/** Households, calls and actions as JSON rows in node:sqlite. ":memory:" for tests. */
export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, household TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, household TEXT NOT NULL, call TEXT, pos INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS calls_household ON calls(household);
    CREATE INDEX IF NOT EXISTS actions_call ON actions(call, pos);
  `);

  type Row = { data: string };
  const one = <T>(sql: string, ...args: SQLInputValue[]) => {
    const row = db.prepare(sql).get(...args) as Row | undefined;
    return row && (JSON.parse(row.data) as T);
  };
  type CallRow = Row & { at: string };
  const toStored = (row: CallRow): StoredCall => {
    const call = JSON.parse(row.data) as CallResult;
    const entries = (db.prepare("SELECT data FROM actions WHERE call = ? ORDER BY pos").all(call.callId) as Row[]).map((r) => JSON.parse(r.data) as Entry);
    return { call: { ...call, actions: entries.map((e) => e.card) }, at: row.at, entries };
  };

  const store = {
    household: (id: string) => one<Household>("SELECT data FROM households WHERE id = ?", id),
    householdByCode: (code: string) => one<Household>("SELECT data FROM households WHERE code = ?", code),
    /** false when the code is already taken; the caller picks another. */
    addHousehold(h: Household, code: string): boolean {
      return db.prepare("INSERT INTO households VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(h.id, code, JSON.stringify(h)).changes === 1;
    },
    saveHousehold: (h: Household) => void db.prepare("UPDATE households SET data = ? WHERE id = ?").run(JSON.stringify(h), h.id),

    /** Stores the call; its cards are stored separately with addAction. */
    addCall: (call: CallResult, householdId: string, at: string) =>
      void db.prepare("INSERT INTO calls VALUES (?, ?, ?, ?)").run(call.callId, householdId, at, JSON.stringify({ ...call, actions: [] })),
    call(id: string): StoredCall | undefined {
      const row = db.prepare("SELECT data, at FROM calls WHERE id = ?").get(id) as CallRow | undefined;
      return row && toStored(row);
    },
    /** Newest → oldest, all of them or the last `limit`. ponytail: one query per call; fine at demo sizes. */
    calls: (householdId: string, limit = -1) =>
      (db.prepare("SELECT data, at FROM calls WHERE household = ? ORDER BY rowid DESC LIMIT ?").all(householdId, limit) as CallRow[]).map(toStored),

    action: (id: string) => one<Entry>("SELECT data FROM actions WHERE id = ?", id),
    /** Appends the card to its call's actions, or puts it first. */
    addAction(e: Entry, { first = false } = {}) {
      const pos = first ? "COALESCE(MIN(pos), 0) - 1" : "COALESCE(MAX(pos), 0) + 1";
      db.prepare(`INSERT INTO actions SELECT ?, ?, ?, ${pos}, ? FROM actions WHERE call IS ?`)
        .run(e.card.id, e.householdId, e.callId ?? null, JSON.stringify(e), e.callId ?? null);
    },
    /** Confirmed (approved) scheduled orders due by `now` (ISO, UTC) and not already being placed. */
    dueOrders: (now: string) =>
      (db.prepare(`SELECT data FROM actions WHERE data ->> '$.card.type' = 'order' AND data ->> '$.card.order.status' = 'scheduled'
        AND data ->> '$.done' AND NOT IFNULL(data ->> '$.placing', 0) AND data ->> '$.card.order.scheduledFor' <= ?`).all(now) as Row[])
        .map((r) => JSON.parse(r.data) as Entry),
    saveAction: (e: Entry) => void db.prepare("UPDATE actions SET data = ? WHERE id = ?").run(JSON.stringify(e), e.card.id),

    /** Drops the fixture household's calls and actions and restores its fixture data. */
    resetDemo() {
      db.prepare("DELETE FROM calls WHERE household = ?").run(householdJson.id);
      db.prepare("DELETE FROM actions WHERE household = ?").run(householdJson.id);
      store.saveHousehold(householdJson as Household);
    },
  };
  store.addHousehold(householdJson as Household, DEMO_CODE); // no-op once seeded
  return store;
}
export type Store = ReturnType<typeof openStore>;
