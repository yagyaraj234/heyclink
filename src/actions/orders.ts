import type { Push } from "./alerts.ts";
import type { Order } from "../contracts.ts";
import type { Entry, Store } from "./store.ts";
import { matchesHouseholdBill } from "./cart.ts";
import type { Swiggy } from "./swiggy.ts";

/** Checks out an order card's cart once. Never retried: a failure stays "failed" for the owner to see. */
export async function placeOrder(entry: Entry, store: Store, swiggy: Swiggy): Promise<Order> {
  const { card } = entry;
  if (card.type !== "order") throw new Error(`action ${card.id} is not an order`);
  // claim before the await, so an overlapping run (or a second approve) skips this order
  entry.placing = true;
  store.saveAction(entry);
  try {
    if (!matchesHouseholdBill(card.order.cart)) throw new Error("Cart quantities or prices need a new review.");
    const { orderId } = await swiggy.checkout(card.order.cart);
    card.order = { ...card.order, status: "placed", orderId, cart: { ...card.order.cart, platform: swiggy.platform } };
  } catch (err) {
    console.error(`order ${card.id} failed:`, err);
    card.order = { ...card.order, status: "failed" };
  }
  delete entry.placing;
  store.saveAction(entry);
  return card.order;
}

/** Places every confirmed order whose scheduledFor has passed. server.ts runs it every 60 s. */
export async function runDue(now: Date, store: Store, swiggy: Swiggy, push?: Push): Promise<Order[]> {
  const [orders] = await Promise.all([
    Promise.all(store.dueOrders(now.toISOString()).map((e) => placeOrder(e, store, swiggy))),
    push && store.alerts.deliver(now.getTime(), push),
  ]);
  return orders;
}
