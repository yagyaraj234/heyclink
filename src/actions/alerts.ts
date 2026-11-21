import type { DatabaseSync } from "node:sqlite";

export type Push = (token: string, cartId: string, kind: "ready" | "reminder") => Promise<void>;

export function openAlerts(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_devices (household TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL);
    CREATE TABLE IF NOT EXISTS cart_alerts (
      cart TEXT NOT NULL, kind TEXT NOT NULL, household TEXT NOT NULL, due INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (cart, kind)
    );
  `);
  return {
    hasDevice(household: string) {
      return !!db.prepare("SELECT 1 FROM owner_devices WHERE household=?").get(household);
    },
    register(household: string, token: string) {
      db.prepare("INSERT OR REPLACE INTO owner_devices VALUES (?,?)").run(household, token);
    },
    queue(household: string, cart: string, kind: "ready" | "reminder", due: number) {
      db.prepare("INSERT OR IGNORE INTO cart_alerts (cart,kind,household,due) SELECT ?,?,?,? WHERE EXISTS (SELECT 1 FROM owner_devices WHERE household=?)")
        .run(cart, kind, household, due, household);
    },
    async deliver(now: number, push: Push) {
      const rows = db.prepare(`SELECT c.*, d.token FROM cart_alerts c JOIN owner_devices d USING(household)
        JOIN actions a ON a.id=c.cart WHERE sent=0 AND due<=? AND NOT (a.data ->> '$.done') AND json_array_length(a.data,'$.card.cart.lines') > 0
        ORDER BY due LIMIT 50`).all(now) as {cart:string; kind:"ready"|"reminder"; token:string; attempts:number}[];
      for (const row of rows) {
        // Lease before network I/O, including across restarts. Transient failures back off.
        const next = now + Math.min(3600_000, 60_000 * 2 ** Math.min(row.attempts, 6));
        if (!db.prepare("UPDATE cart_alerts SET due=?, attempts=attempts+1 WHERE cart=? AND kind=? AND sent=0 AND due<=? AND EXISTS (SELECT 1 FROM actions WHERE id=cart AND NOT (data ->> '$.done') AND json_array_length(data,'$.card.cart.lines') > 0)")
          .run(next, row.cart, row.kind, now).changes) continue;
        try {
          await push(row.token, row.cart, row.kind);
          db.prepare("UPDATE cart_alerts SET sent=1 WHERE cart=? AND kind=?").run(row.cart, row.kind);
        } catch (err) {
          if (err instanceof Error && err.message === "DeviceNotRegistered") {
            db.prepare("DELETE FROM owner_devices WHERE token=?").run(row.token);
          } else console.warn("Cart notification delivery failed");
        }
      }
    },
  };
}

export const expoPush: Push = async (to, cartId, kind) => {
  const headers: Record<string,string> = {"content-type": "application/json"};
  if (process.env.EXPO_ACCESS_TOKEN) headers.authorization = "Bearer " + process.env.EXPO_ACCESS_TOKEN;
  const res = await fetch("https://exp.host/--/api/v2/push/send", {
    method: "POST", headers, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({to, title: kind === "ready" ? "Groceries ready to review" : "Your grocery reminder",
      body: "Open Kitchen to review your household cart.", data: {cartId}, sound: "default", channelId: "groceries"}),
  });
  if (!res.ok) throw new Error("Expo returned " + res.status);
  const {data} = await res.json();
  const ticket = Array.isArray(data) ? data[0] : data;
  if (ticket?.status !== "ok") throw new Error(ticket?.details?.error || "Expo rejected the notification");
};
