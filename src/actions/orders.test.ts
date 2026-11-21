import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionCard, Cart } from "../contracts.ts";
import { openStore } from "./store.ts";
import type { Store } from "./store.ts";
import { runDue } from "./orders.ts";
import type { Swiggy } from "./swiggy.ts";

const cart: Cart = {
  lines: [{ item: "atta", qty: 2, unit: "kg", brand: "aashirvaad", price: 132, searchUrl: "https://www.swiggy.com/instamart/search?query=aashirvaad%20atta" }],
  total: 132,
  platform: "mock",
};

// Fake for the network: counts checkouts, can fail, and lets a test hold a checkout open.
function fakeSwiggy({ fail = false, gate }: { fail?: boolean; gate?: Promise<void> } = {}) {
  const carts: Cart[] = [];
  const swiggy: Swiggy = {
    platform: "instamart",
    async checkout(c) {
      carts.push(c);
      await gate;
      if (fail) throw new Error("instamart said no");
      return { orderId: `SWG-${carts.length}` };
    },
  };
  return { swiggy, carts };
}

/** An order card as the app stores it; confirmed = the owner approved the order card. */
function addOrder(store: Store, id: string, scheduledFor: string, confirmed = true) {
  const card: ActionCard = { id, type: "order", order: { cart, status: "scheduled", scheduledFor }, needsApproval: true };
  store.addAction({ card, householdId: "h1", done: confirmed });
}
const orderOf = (store: Store, id: string) => {
  const card = store.action(id)!.card;
  assert.ok(card.type === "order");
  return card.order;
};

const NOW = new Date("2026-11-22T03:30:00.000Z"); // 9 AM IST

test("runDue places confirmed orders that are due, exactly once", async () => {
  const store = openStore();
  const { swiggy, carts } = fakeSwiggy();
  addOrder(store, "due", "2026-11-22T03:00:00.000Z");
  addOrder(store, "later", "2026-11-22T05:00:00.000Z");
  addOrder(store, "unconfirmed", "2026-11-22T03:00:00.000Z", false);

  const placed = await runDue(NOW, store, swiggy);
  assert.deepEqual(placed, [{ cart: { ...cart, platform: "instamart" }, status: "placed", scheduledFor: "2026-11-22T03:00:00.000Z", orderId: "SWG-1" }]);
  assert.deepEqual(orderOf(store, "due"), placed[0]);
  assert.equal(orderOf(store, "later").status, "scheduled");
  assert.equal(orderOf(store, "unconfirmed").status, "scheduled");

  assert.deepEqual(await runDue(NOW, store, swiggy), []);
  assert.equal(carts.length, 1);
});

test("runDue runs that overlap still check out once", async () => {
  const store = openStore();
  let open!: () => void;
  const { swiggy, carts } = fakeSwiggy({ gate: new Promise((r) => (open = r)) });
  addOrder(store, "due", "2026-11-22T03:00:00.000Z");

  const first = runDue(NOW, store, swiggy);
  const second = runDue(NOW, store, swiggy); // the 60 s tick fires again while the first checkout hangs
  open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(carts.length, 1);
  assert.deepEqual([a.length, b.length], [1, 0]);
});

test("a failed checkout marks the order failed and is not retried", async () => {
  const store = openStore();
  const { swiggy, carts } = fakeSwiggy({ fail: true });
  addOrder(store, "due", "2026-11-22T03:00:00.000Z");

  const [order] = await runDue(NOW, store, swiggy);
  assert.equal(order?.status, "failed");
  assert.equal(orderOf(store, "due").status, "failed");
  assert.deepEqual(await runDue(NOW, store, swiggy), []);
  assert.equal(carts.length, 1);
});
