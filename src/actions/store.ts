import { DatabaseSync } from "node:sqlite";
import type { ActionCard, CallResult, GroceryLine, Household } from "../contracts.ts";
import householdJson from "../../fixtures/household.json" with { type: "json" };

/** Fixed join code for the seeded fixture household, so the cook role can be demoed on h1. */
export const DEMO_CODE = "TADKA2";
export const fixtureHousehold = () => structuredClone(householdJson) as Household;

// done = approved (cart/advance) or answered (question). lines = what the cart is built from.
// choices = per question option, the line it adds to the cart (null = adds nothing).
export type Entry = {
  card: ActionCard; householdId: string; callId?: string; done: boolean; lines?: GroceryLine[]; choices?: (GroceryLine | null)[];
};
/** call.actions is rebuilt from the action rows, so a card edited through its Entry shows up in the call. */
export type StoredCall = { call: CallResult; householdId: string; at: string; entries: Entry[] };

/** Households, calls and actions as JSON rows in node:sqlite. ":memory:" for tests. */
export function openStore(path = ":memory:") {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS households (id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calls (id TEXT PRIMARY KEY, household TEXT NOT NULL, at TEXT NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS actions (id TEXT PRIMARY KEY, household TEXT NOT NULL, call TEXT, pos INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO households VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(householdJson.id, DEMO_CODE, JSON.stringify(householdJson));

  type CallRow = { data: string; household: string; at: string };
  const entriesOf = (callId: string) =>
    (db.prepare("SELECT data FROM actions WHERE call = ? ORDER BY pos").all(callId) as { data: string }[]).map((r) => JSON.parse(r.data) as Entry);
  const toStored = (row: CallRow): StoredCall => {
    const call = JSON.parse(row.data) as CallResult;
    const entries = entriesOf(call.callId);
    return { call: { ...call, actions: entries.map((e) => e.card) }, householdId: row.household, at: row.at, entries };
  };

  return {
    household(id: string): Household | undefined {
      const row = db.prepare("SELECT data FROM households WHERE id = ?").get(id) as { data: string } | undefined;
      return row && JSON.parse(row.data);
    },
    householdIdByCode: (code: string) => (db.prepare("SELECT id FROM households WHERE code = ?").get(code) as { id: string } | undefined)?.id,
    /** false when the code is already taken; the caller picks another. */
    addHousehold(h: Household, code: string): boolean {
      return db.prepare("INSERT INTO households VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(h.id, code, JSON.stringify(h)).changes === 1;
    },
    saveHousehold: (h: Household) => void db.prepare("UPDATE households SET data = ? WHERE id = ?").run(JSON.stringify(h), h.id),

    /** Stores the call; its cards are stored separately with addAction. */
    addCall: (call: CallResult, householdId: string, at: string) =>
      void db.prepare("INSERT INTO calls VALUES (?, ?, ?, ?)").run(call.callId, householdId, at, JSON.stringify({ ...call, actions: [] })),
    call(id: string): StoredCall | undefined {
      const row = db.prepare("SELECT data, household, at FROM calls WHERE id = ?").get(id) as CallRow | undefined;
      return row && toStored(row);
    },
    /** Oldest → newest. ponytail: one query per call; fine at demo sizes. */
    calls: (householdId: string) =>
      (db.prepare("SELECT data, household, at FROM calls WHERE household = ? ORDER BY rowid").all(householdId) as CallRow[]).map(toStored),

    action(id: string): Entry | undefined {
      const row = db.prepare("SELECT data FROM actions WHERE id = ?").get(id) as { data: string } | undefined;
      return row && JSON.parse(row.data);
    },
    /** Appends the card to its call's actions, or puts it first. */
    addAction(e: Entry, { first = false } = {}) {
      const pos = first ? "COALESCE(MIN(pos), 0) - 1" : "COALESCE(MAX(pos), 0) + 1";
      db.prepare(`INSERT INTO actions SELECT ?, ?, ?, ${pos}, ? FROM actions WHERE call IS ?`)
        .run(e.card.id, e.householdId, e.callId ?? null, JSON.stringify(e), e.callId ?? null);
    },
    saveAction: (e: Entry) => void db.prepare("UPDATE actions SET data = ? WHERE id = ?").run(JSON.stringify(e), e.card.id),

    /** Drops the household's calls and actions and restores its fixture data. */
    reset(h: Household) {
      db.prepare("DELETE FROM calls WHERE household = ?").run(h.id);
      db.prepare("DELETE FROM actions WHERE household = ?").run(h.id);
      this.saveHousehold(h);
    },
  };
}
export type Store = ReturnType<typeof openStore>;
