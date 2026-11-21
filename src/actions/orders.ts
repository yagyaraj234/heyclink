import type { Push } from "./alerts.ts";
import type { Order } from "../contracts.ts";
import type { Entry, Store } from "./store.ts";
import { matchesHouseholdBill } from "./cart.ts";
import type { Swiggy } from "./swiggy.ts";

/** Checks out an order card's cart once. Never retried: a failure stays "failed" for the owner to see. */
export async function placeOrder(entry: Entry, store: Store, swiggy: Swiggy, now = new Date()): Promise<Order> {
  const { card } = entry;
  if (card.type !== "order") throw new Error(`action ${card.id} is not an order`);
  // claim before the await, so an overlapping run (or a second approve) skips this order
  if (!(await store.claimOrder(card.id, now.toISOString()))) {
    const current = await store.action(card.id);
    if (current?.card.type !== "order") throw new Error("Order no longer exists");
    return current.card.order;
  }
  try {
    if (!matchesHouseholdBill(card.order.cart)) throw new Error("Cart quantities or prices need a new review.");
    const { orderId } = await swiggy.checkout(card.order.cart);
    card.order = { ...card.order, status: "placed", orderId, cart: { ...card.order.cart, platform: swiggy.platform } };
  } catch (err) {
    console.error(`order ${card.id} failed:`, err);
    card.order = { ...card.order, status: "failed" };
  }
  await store.finishOrder(entry);
  return card.order;
}

/** A checkout claimed longer ago than this belongs to an instance that died mid-checkout. */
const ABANDONED_MS = 10 * 60_000;

/** Places confirmed orders due now. server.ts runs it every 60 s on every instance. */
export async function runDue(now: Date, store: Store, swiggy: Swiggy, push?: Push): Promise<Order[]> {
  await store.failAbandonedCheckouts(new Date(now.getTime() - ABANDONED_MS).toISOString());
  const [orders] = await Promise.all([
    Promise.all((await store.dueOrders(now.toISOString())).map((e) => placeOrder(e, store, swiggy, now))),
    push && store.alerts.deliver(now.getTime(), push),
  ]);
  return orders;
}
