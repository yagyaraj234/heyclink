import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { createApp } from "../app.ts";
import { processCall } from "../pipeline/process.ts";
import { openStore } from "./store.ts";
import type { Llm } from "../contracts.ts";

async function setup(t: TestContext) {
  const store = await openStore();
  const llm: Llm = {
    json: async <T>() =>
      ({
        groceries: [
          {
            stockout: true,
            item: "onion",
            raw: "250 g pyaaz",
            itemWord: "onion",
            qtyPhrase: "250 g",
            qty: 250,
            unit: "g",
            confidence: 1,
          },
          {
            stockout: true,
            item: "mint",
            raw: "pudina",
            itemWord: "mint",
            qtyPhrase: "",
            qty: 1,
            unit: "bunch",
            confidence: 1,
          },
        ],
        notes: [],
        advance: null,
      }) as T,
  };
  const server = createApp({
    processCall,
    store,
    llm,
    stt: {
      transcribe: async () => {
        throw Error("expected text input");
      },
    },
  }).listen(0, "127.0.0.1");
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = "http://127.0.0.1:" + addr.port;
  let token = "";
  const post = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + token,
      },
      body: JSON.stringify(body),
    });
  const signup = await post("/households", {
    owner: { name: "A", phone: "1234" },
    cook: { name: "B", lang: "hi", upiId: "b@example", monthlySalary: 0 },
    approvalLimit: 100,
  });
  assert.equal(signup.status, 201);
  const owner = await signup.json();
  token = owner.ownerToken;
  const call = await (await post("/calls", { householdId: owner.id, transcript: "pyaaz and mint" })).json();
  const card = call.actions[0];
  const track = (body: Record<string, unknown>) =>
    post("/actions/" + card.id + "/tracking", { reviewId: card.cart.reviewId, ...body });
  const detail = (owner = false) =>
    fetch(base + "/calls/" + call.callId, owner ? { headers: { authorization: "Bearer " + token } } : {});
  return { store, post, base, owner, card, track, detail, call };
}

test("owner manual confirmation freezes reviewed pack sizes for both household history and the cook receipt", async (t) => {
  const { track, detail, card } = await setup(t);
  const result = await track({ state: "ordered", source: "manual" });
  assert.equal(result.status, 200);
  const { receipt } = await result.json();
  assert.equal(receipt?.source, "manual");
  assert.deepEqual(receipt.lines[0], {
    item: "onion",
    qty: 500,
    unit: "g",
    pack: { count: 1, size: 500, unit: "g" },
    price: 22,
  });
  const cook = (await (await detail()).json()).tracking[card.id].receipt;
  assert.deepEqual(cook.lines[0], { item: "onion", qty: 500, unit: "g", pack: { count: 1, size: 500, unit: "g" } });
  assert.equal(cook.total, undefined);
});

test("a retailer claim without a handed-off bill cannot confirm a draft or silently switch to manual", async (t) => {
  const { store, card, track, post, detail } = await setup(t);
  const revision = createHash("sha256").update(JSON.stringify(card.cart)).digest("hex");
  await store.claimInstamart(card.id, revision);
  assert.equal((await track({ state: "ordered" })).status, 409);
  assert.equal((await track({ state: "ordered", source: "instamart" })).status, 409);
  assert.equal((await post("/actions/" + card.id + "/approve", {})).status, 409);
  assert.equal((await (await detail(true)).json()).tracking[card.id].instamartPending, true);
  assert.equal((await track({ state: "ordered", source: "manual" })).status, 200);
});

test("provider handoff binds owner confirmation to its exact bill and writes only the household's added packs", async (t) => {
  const { store, card, track, detail, base, owner } = await setup(t);
  const revision = createHash("sha256").update(JSON.stringify(card.cart)).digest("hex");
  await store.claimInstamart(card.id, revision);
  const lines = [
    { item: "onion", qty: 750, unit: "g" as const, pack: { count: 3, size: 250, unit: "g" as const }, price: 48 },
  ];
  const receipt = {
    source: "instamart" as const,
    lines,
    total: "₹78",
    fees: [{ label: "Delivery", value: "₹10" }],
    address: "Home",
  };
  await store.saveInstamartReceipt(card.id, revision, receipt);
  const first = (await (await detail(true)).json()).tracking[card.id].receipt;
  assert.deepEqual(first.lines, lines);
  assert.equal(first.total, "₹78");
  const preview = (await (await detail()).json()).tracking?.[card.id]?.receipt;
  assert.deepEqual(preview?.lines, [{ item: "onion", qty: 750, unit: "g", pack: { count: 3, size: 250, unit: "g" } }]);
  assert.equal(preview.address, undefined);
  assert.equal(preview.receiptId, undefined);
  await store.saveInstamartReceipt(card.id, revision, { ...receipt, total: "₹76" });
  const latest = (await (await detail(true)).json()).tracking[card.id].receipt;
  assert.notEqual(latest.receiptId, first.receiptId);
  assert.equal((await track({ state: "ordered", source: "instamart", receiptId: first.receiptId })).status, 409);
  for (let i = 0; i < 2; i++)
    assert.equal((await track({ state: "ordered", source: "instamart", receiptId: latest.receiptId })).status, 200);
  assert.equal((await track({ state: "delivered" })).status, 200);
  const household = await (await fetch(base + "/households/" + owner.id)).json();
  assert.deepEqual(
    household.history.map((h: { lines: unknown }) => h.lines),
    [[{ item: "onion", qty: 750, unit: "g" }]],
  );
  const cook = (await (await detail()).json()).tracking[card.id];
  assert.equal(cook.state, "delivered");
  assert.deepEqual(cook.receipt.lines, [
    { item: "onion", qty: 750, unit: "g", pack: { count: 3, size: 250, unit: "g" } },
  ]);
  assert.equal(cook.receipt.address, undefined);
});

test("stockouts learn only delivered items in the receipt and combine mixed retailer pack units", async (t) => {
  const { store, owner, card, track, detail, post } = await setup(t);
  const revision = createHash("sha256").update(JSON.stringify(card.cart)).digest("hex");
  await store.claimInstamart(card.id, revision);
  await store.saveInstamartReceipt(card.id, revision, {
    source: "instamart",
    lines: [
      { item: "onion", qty: 1, unit: "kg", pack: { count: 1, size: 1, unit: "kg" } },
      { item: "onion", qty: 500, unit: "g", pack: { count: 2, size: 250, unit: "g" } },
    ],
  });
  const { receipt } = (await (await detail(true)).json()).tracking[card.id];
  await track({ state: "ordered", source: "instamart", receiptId: receipt.receiptId });
  await track({ state: "delivered" });
  const res = await post("/calls", { householdId: owner.id, transcript: "pyaaz and mint khatam" });
  assert.equal(res.status, 201);
  assert.deepEqual((await res.json()).usage, [{ item: "onion", qty: 1.5, unit: "kg", days: 0, samples: 1 }]);
});

test("a fresh provider bill read invalidates prior handoff and an older in-flight read cannot restore it", async (t) => {
  const { store, card, track, detail } = await setup(t);
  const revision = createHash("sha256").update(JSON.stringify(card.cart)).digest("hex");
  await store.claimInstamart(card.id, revision);
  const draft = {
    source: "instamart" as const,
    lines: [{ item: "onion", qty: 500, unit: "g" as const, pack: { count: 1, size: 500, unit: "g" as const } }],
  };
  await store.saveInstamartReceipt(card.id, revision, draft);
  const { receipt } = (await (await detail(true)).json()).tracking[card.id];
  const first = await store.beginInstamartReview(card.id, revision);
  const latest = await store.beginInstamartReview(card.id, revision);
  assert.equal((await track({ state: "ordered", source: "instamart", receiptId: receipt.receiptId })).status, 409);
  assert.equal(await store.isInstamartReviewCurrent(card.id, revision, first), false);
  await assert.rejects(store.saveInstamartReceipt(card.id, revision, draft, first));
  await store.saveInstamartReceipt(card.id, revision, draft, latest);
  assert.equal((await (await detail(true)).json()).tracking[card.id].receipt.source, "instamart");
});

test("a demo order adds actual packs to history once, only after placement", async (t) => {
  const { post, base, owner, card } = await setup(t);
  const history = async () => (await (await fetch(base + "/households/" + owner.id)).json()).history;
  const draft = await (
    await post("/actions/" + card.id + "/approve", { order: "now", reviewId: card.cart.reviewId })
  ).json();
  assert.deepEqual(await history(), []);
  const confirm = () => post("/actions/" + draft.order.id + "/approve", { reviewId: card.cart.reviewId });
  assert.equal((await (await confirm()).json()).order.status, "placed");
  assert.equal((await confirm()).status, 200);
  assert.deepEqual(
    (await history()).map((entry: { lines: unknown }) => entry.lines),
    [
      [
        { item: "onion", qty: 500, unit: "g" },
        { item: "mint", qty: 1, unit: "bunch" },
      ],
    ],
  );
});
