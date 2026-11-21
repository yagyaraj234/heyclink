import type { Query, Tx } from "./store.ts";

export type Push = (token: string, cartId: string, kind: "ready" | "reminder") => Promise<void>;

// due is epoch ms, so bigint.
export const ALERTS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS owner_devices (household text PRIMARY KEY, token text UNIQUE NOT NULL);
  CREATE TABLE IF NOT EXISTS cart_alerts (
    cart text NOT NULL, kind text NOT NULL, household text NOT NULL, due bigint NOT NULL,
    attempts integer NOT NULL DEFAULT 0, sent boolean NOT NULL DEFAULT false, PRIMARY KEY (cart, kind)
  );
`;

// An undone cart with lines; "ready" alerts only for cook-sent carts.
const ALERTABLE = `NOT (a.data::jsonb ->> 'done')::boolean AND jsonb_array_length(a.data::jsonb #> '{card,cart,lines}') > 0
  AND (c.kind <> 'ready' OR a.call IS NOT NULL)`;

export function openAlerts(q: Query, tx: Tx) {
  return {
    async hasDevice(household: string) {
      return !!(await q("SELECT 1 FROM owner_devices WHERE household = $1", household)).rowCount;
    },
    /** One device per household and one household per device: the newest registration wins. */
    register: (household: string, token: string) => tx(async () => {
      await q("DELETE FROM owner_devices WHERE household = $1 OR token = $2", household, token);
      await q("INSERT INTO owner_devices VALUES ($1, $2)", household, token);
    }),
    async queue(household: string, cart: string, kind: "ready" | "reminder", due: number) {
      await q(`INSERT INTO cart_alerts (cart, kind, household, due) SELECT $1::text, $2::text, $3::text, $4::bigint
        WHERE EXISTS (SELECT 1 FROM owner_devices WHERE household = $3::text) ON CONFLICT DO NOTHING`, cart, kind, household, due);
    },
    async deliver(now: number, push: Push) {
      const rows = (await q<{cart: string; kind: "ready" | "reminder"; token: string; attempts: number}>(`
        SELECT c.cart, c.kind, c.attempts, d.token FROM cart_alerts c JOIN owner_devices d USING (household)
        JOIN actions a ON a.id = c.cart WHERE NOT c.sent AND c.due <= $1 AND ${ALERTABLE}
        ORDER BY c.due LIMIT 50`, now)).rows;
      for (const row of rows) {
        // Lease before network I/O, including across restarts and instances. Transient failures back off.
        const next = now + Math.min(3600_000, 60_000 * 2 ** Math.min(row.attempts, 6));
        if (!(await q(`UPDATE cart_alerts c SET due = $1, attempts = attempts + 1
            WHERE cart = $2 AND kind = $3 AND NOT sent AND due <= $4
            AND EXISTS (SELECT 1 FROM actions a WHERE a.id = c.cart AND ${ALERTABLE})`, next, row.cart, row.kind, now)).rowCount) continue;
        try {
          await push(row.token, row.cart, row.kind);
          await q("UPDATE cart_alerts SET sent = true WHERE cart = $1 AND kind = $2", row.cart, row.kind);
        } catch (err) {
          if (err instanceof Error && err.message === "DeviceNotRegistered") {
            await q("DELETE FROM owner_devices WHERE token = $1", row.token);
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
