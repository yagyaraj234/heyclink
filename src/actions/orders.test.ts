import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionCard, CallResult, Cart } from "../contracts.ts";
import { openStore } from "./store.ts";
import type { Store } from "./store.ts";
import { runDue } from "./orders.ts";
import type { Swiggy } from "./swiggy.ts";

const cart: Cart & {reviewId: string} = {
  reviewId: "reviewed-atta",
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
async function addOrder(store: Store, id: string, scheduledFor: string, confirmed = true) {
  const card: ActionCard = { id, type: "order", order: { cart, status: "scheduled", scheduledFor }, needsApproval: true };
  await store.addAction({ card, householdId: "h1", done: confirmed });
}
const orderOf = async (store: Store, id: string) => {
  const card = (await store.action(id))!.card;
  assert.ok(card.type === "order");
  return card.order;
};

const NOW = new Date("2026-11-22T03:30:00.000Z"); // 9 AM IST

test("runDue places confirmed orders that are due, exactly once", async () => {
  const store = await openStore();
  const { swiggy, carts } = fakeSwiggy();
  const history = (await store.household("h1"))!.history.length;
  await addOrder(store, "due", "2026-11-22T03:00:00.000Z");
  await addOrder(store, "later", "2026-11-22T05:00:00.000Z");
  await addOrder(store, "unconfirmed", "2026-11-22T03:00:00.000Z", false);

  const placed = await runDue(NOW, store, swiggy);
  assert.deepEqual(placed, [{ cart: { ...cart, platform: "instamart" }, status: "placed", scheduledFor: "2026-11-22T03:00:00.000Z", orderId: "SWG-1" }]);
  assert.deepEqual(await orderOf(store, "due"), placed[0]);
  assert.equal((await orderOf(store, "later")).status, "scheduled");
  assert.equal((await orderOf(store, "unconfirmed")).status, "scheduled");

  assert.deepEqual(await runDue(NOW, store, swiggy), []);
  assert.equal(carts.length, 1);
  assert.equal((await store.household("h1"))!.history.length, history + 1);
});

test("runDue runs that overlap still check out once", async () => {
  const store = await openStore();
  let open!: () => void;
  const { swiggy, carts } = fakeSwiggy({ gate: new Promise((r) => (open = r)) });
  await addOrder(store, "due", "2026-11-22T03:00:00.000Z");

  const first = runDue(NOW, store, swiggy);
  const second = runDue(NOW, store, swiggy); // the 60 s tick fires again while the first checkout hangs
  open();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(carts.length, 1);
  assert.deepEqual([a.length, b.length], [1, 0]);
});

test("after restart, interrupted checkouts fail and confirmed orders without a claim still run", async () => {
  const before = await openStore();
  await addOrder(before, "interrupted", "2026-11-22T03:00:00.000Z");
  assert.equal(await before.claimOrder("interrupted"), true);
  await before.addAction({
    householdId: "h1",
    done: true,
    card: { id: "now", type: "order", order: { cart, status: "scheduled" }, needsApproval: true },
  });
  await addOrder(before, "unconfirmed", "2026-11-22T03:00:00.000Z", false);

  const after = await openStore({ schema: before.schema, recoverInterruptedOrders: true });
  const { swiggy, carts } = fakeSwiggy();
  const placed = await runDue(NOW, after, swiggy);
  assert.equal((await orderOf(after, "interrupted")).status, "failed");
  assert.equal((await orderOf(after, "now")).status, "placed");
  assert.equal((await orderOf(after, "unconfirmed")).status, "scheduled");
  assert.equal(placed.length, 1);
  assert.equal(carts.length, 1);
  assert.deepEqual(await runDue(NOW, after, swiggy), []);
});

test("a failed checkout marks the order failed and is not retried", async () => {
  const store = await openStore();
  const { swiggy, carts } = fakeSwiggy({ fail: true });
  const history = (await store.household("h1"))!.history;
  await addOrder(store, "due", "2026-11-22T03:00:00.000Z");

  const [order] = await runDue(NOW, store, swiggy);
  assert.equal(order?.status, "failed");
  assert.equal((await orderOf(store, "due")).status, "failed");
  assert.deepEqual((await store.household("h1"))!.history, history);
  assert.deepEqual(await runDue(NOW, store, swiggy), []);
  assert.equal(carts.length, 1);
});

test("runDue fails a legacy bulk order before it reaches checkout", async () => {
  const store = await openStore();
  const { swiggy, carts } = fakeSwiggy();
  await addOrder(store, "bulk", "2026-11-22T01:00:00Z");
  const old = (await store.action("bulk"))!;
  assert.ok(old.card.type === "order");
  old.card.order.cart.lines[0]!.qty = 500;
  await store.saveAction(old);
  const [order] = await runDue(NOW, store, swiggy);
  assert.equal(order?.status, "failed");
  assert.equal(carts.length, 0);
});

test('runDue sends one reminder at the selected time across repeated scheduler ticks', async () => {
  const store = await openStore();
  await store.alerts.register('h1','ExpoPushToken[test]');
  await store.addAction({householdId:'h1',done:false,card:{id:'list',type:'cart',cart,needsApproval:true}});
  await store.alerts.queue('h1','list','reminder',NOW.getTime());
  await store.alerts.queue('h1','list','reminder',NOW.getTime());
  const deliveries: string[] = [];
  const {swiggy} = fakeSwiggy();
  const push = async (_token: string, _cart: string, kind: string) => {deliveries.push(kind);};
  await runDue(new Date(NOW.getTime()-1),store,swiggy,push);
  assert.equal(deliveries.includes('reminder'),false);
  await Promise.all([runDue(NOW,store,swiggy,push),runDue(NOW,store,swiggy,push)]);
  assert.deepEqual(deliveries.filter(kind=>kind==='reminder'),['reminder']);
});

test('an explicit cook deadline schedules one reminder thirty minutes before the groceries are needed', async () => {
  const store = await openStore();
  const deadline = new Date(Date.now() + 3600_000);
  const extraction = {groceries:[], notes:[], neededBy:deadline.toISOString()};
  await store.alerts.register('h1','ExpoPushToken[test]');
  await store.addCall({callId:'deadline',transcript:{text:'by dinner',lang:'en',provider:'fake'},extraction,actions:[],
    timings:{sttMs:0,extractMs:0,planMs:0,totalMs:0}},'h1',new Date().toISOString());
  await store.addAction({householdId:'h1',callId:'deadline',done:false,card:{id:'dinner',type:'cart',cart,needsApproval:true}});
  const deliveries: string[] = [];
  const push = async (_token:string,_cartId:string,kind:string) => { deliveries.push(kind); };
  const {swiggy} = fakeSwiggy();
  await runDue(new Date(deadline.getTime()-1800_001),store,swiggy,push);
  assert.deepEqual(deliveries,['ready']);
  await runDue(new Date(deadline.getTime()-1800_000),store,swiggy,push);
  assert.deepEqual(deliveries,['ready','reminder']);
});

test('a cart emptied before the notification is sent stays silent', async () => {
  const store = await openStore();
  await store.alerts.register('h1','ExpoPushToken[test]');
  const card = {type:'cart',id:'empty',needsApproval:true,cart} satisfies ActionCard;
  await store.addAction({householdId:'h1',callId:'note-with-items',done:false,card});
  await store.saveAction({householdId:'h1',done:false,card:{...card,cart:{...cart,lines:[],total:0}}});
  const deliveries: string[] = [];
  await runDue(new Date(),store,fakeSwiggy().swiggy,async (_,id) => { deliveries.push(id); });
  assert.deepEqual(deliveries,[]);
});

test("standalone meal ingredients and empty cook lists do not notify the owner", async () => {
  const store = await openStore();
  await store.alerts.register("h1","ExpoPushToken[demo]");
  const note: CallResult = {callId:"cook-note",transcript:{text:"pyaaz",lang:"hi",provider:"fake"},extraction:{groceries:[],notes:[]},actions:[],
    timings:{sttMs:0,extractMs:0,planMs:0,totalMs:0}};
  await store.addCall(note,"h1",NOW.toISOString());
  await store.addAction({householdId:"h1",done:false,card:{id:"owner-meal",type:"cart",cart,needsApproval:false}});
  // An earlier release already queued this owner-created cart before the server restarted.
  await store.alerts.queue("h1","owner-meal","ready",0);
  await store.addAction({householdId:"h1",callId:"cook-note",done:false,card:{id:"empty-list",type:"cart",cart:{...cart,lines:[],total:0},needsApproval:false}});
  await store.addAction({householdId:"h1",callId:"cook-note",done:false,card:{id:"from-cook",type:"cart",cart,needsApproval:false}});
  const pushes: string[] = [];
  await runDue(new Date(),store,fakeSwiggy().swiggy,async (_token,id,kind) => { pushes.push(id+" "+kind); });
  assert.deepEqual(pushes,["from-cook ready"]);
});

test("two server instances on one database check out a due order once", async () => {
  const first = await openStore();
  const second = await openStore({ schema: first.schema }); // same database, separate pool
  let open!: () => void;
  const { swiggy, carts } = fakeSwiggy({ gate: new Promise((r) => (open = r)) });
  await addOrder(first, "due", "2026-11-22T03:00:00.000Z");

  const runs = [runDue(NOW, first, swiggy), runDue(NOW, second, swiggy)];
  open();
  await Promise.all(runs);
  assert.equal(carts.length, 1);
  assert.equal((await orderOf(second, "due")).status, "placed");
});
