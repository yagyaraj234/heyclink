import { test } from "node:test";
import assert from "node:assert/strict";
import type { ActionCard, Extraction, GroceryLine, Household } from "../contracts.ts";
import householdJson from "../../fixtures/household.json" with { type: "json" };
import items from "../../fixtures/items.json" with { type: "json" };
import case01 from "../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import case02 from "../../fixtures/cases/cook-hinglish-02.json" with { type: "json" };
import { buildCart } from "./cart.ts";
import { planActions } from "./plan.ts";

const household = () => structuredClone(householdJson) as Household;
const gold = (c: { gold: { groceries: unknown[] } }) => c.gold.groceries as GroceryLine[];

test("buildCart prices cook-hinglish-01 with household brands", async () => {
  const cart = await buildCart(gold(case01), household());
  // atta 2 kg × aashirvaad 1 kg @66 = 132; coriander 2 bunch @15 = 30; milk 1 packet amul @34 = 34
  assert.deepEqual(cart.lines.map((l) => l.price), [132, 30, 34]);
  assert.equal(cart.total, 196);
  assert.equal(cart.platform, "mock");
  assert.equal(cart.lines[0]?.brand, "aashirvaad");
  assert.equal(cart.lines[0]?.searchUrl, "https://www.swiggy.com/instamart/search?query=aashirvaad%20atta");
  assert.equal(cart.lines[1]?.searchUrl, "https://www.swiggy.com/instamart/search?query=coriander%20leaves");
});

test("buildCart converts kg/l lines into catalog packs (cook-hinglish-02)", async () => {
  const cart = await buildCart(gold(case02), household());
  // onion 1.5 kg / 500 g packs = 3 × 22 = 66; green-chilli 250 g / 100 g = 3 × 10 = 30; curd 0.5 l / 400 g = 2 × 35 = 70
  assert.deepEqual(cart.lines.map((l) => l.price), [66, 30, 70]);
  assert.equal(cart.total, 166);
});

test("buildCart falls back to household brand, then base price for unknown brands", async () => {
  const lines: GroceryLine[] = [
    { raw: "do kilo chawal", item: "rice", qty: 2, unit: "kg", confidence: 1 },
    { raw: "ek packet xyz atta", item: "atta", qty: 1, unit: "packet", brand: "xyz", confidence: 1 },
    { raw: "ek darjan kela", item: "banana", qty: 12, unit: "piece", confidence: 1 },
  ];
  const cart = await buildCart(lines, household());
  // rice india-gate 2 × 82 = 164; atta unknown brand → base 58; 12 piece = 1 dozen × 60
  assert.deepEqual(cart.lines.map((l) => [l.brand, l.price]), [["india-gate", 164], ["xyz", 58], [undefined, 60]]);
});

test("catalog prices every canonical item id", async () => {
  const lines = items.map((item): GroceryLine => ({ raw: item, item, qty: 1, unit: "packet", confidence: 1 }));
  const cart = await buildCart(lines, household());
  assert.deepEqual(cart.lines.filter((l) => !(l.price > 0)).map((l) => l.item), []);
});

const byType = <T extends ActionCard["type"]>(cards: ActionCard[], type: T) =>
  cards.filter((c): c is Extract<ActionCard, { type: T }> => c.type === type);

test("planActions on cook-hinglish-01: cart under limit + advance card with UPI link", async () => {
  const cards = await planActions(case01.gold as Extraction, household());
  assert.deepEqual(cards.map((c) => c.type), ["cart", "advance"]);
  const [cart] = byType(cards, "cart");
  assert.equal(cart?.cart.total, 196);
  assert.equal(cart?.needsApproval, false);
  const [adv] = byType(cards, "advance");
  assert.equal(adv?.payee, "Lakshmi");
  assert.deepEqual(adv?.advance, { amount: 500 });
  assert.equal(adv?.needsApproval, true);
  assert.equal(adv?.upiUrl, "upi://pay?pa=lakshmi@okaxis&pn=Lakshmi&am=500&cu=INR&tn=Advance");
  assert.equal(new Set(cards.map((c) => c.id)).size, 2);
});

test("planActions needs approval only when total is strictly above approvalLimit", async () => {
  const ex = { groceries: gold(case01), notes: [] } satisfies Extraction;
  const at = await planActions(ex, { ...household(), approvalLimit: 196 });
  const above = await planActions(ex, { ...household(), approvalLimit: 195 });
  assert.equal(byType(at, "cart")[0]?.needsApproval, false);
  assert.equal(byType(above, "cart")[0]?.needsApproval, true);
});

test("planActions turns confidence < 0.6 lines into questions and keeps them out of the cart", async () => {
  const ex: Extraction = {
    groceries: [
      { raw: "do gaddi dhaniya", item: "coriander", qty: 2, unit: "bunch", confidence: 0.6 },
      { raw: "thoda methi", item: "methi", qty: 1, unit: "bunch", confidence: 0.59 },
    ],
    notes: [],
  };
  const cards = await planActions(ex, household());
  assert.deepEqual(cards.map((c) => c.type), ["cart", "question"]);
  assert.deepEqual(byType(cards, "cart")[0]?.cart.lines.map((l) => l.item), ["coriander"]);
  const [q] = byType(cards, "question");
  assert.equal(q?.text, 'Did Lakshmi mean 1 bunch Methi Leaves? (heard: "thoda methi")');
  assert.deepEqual(q?.options, ["Yes, add it", "No, skip"]);
});

test("planActions with nothing confident and no advance yields only questions", async () => {
  const ex: Extraction = { groceries: [{ raw: "woh wala", item: "atta", qty: 1, unit: "kg", confidence: 0.2 }], notes: ["hello"] };
  const cards = await planActions(ex, household());
  assert.deepEqual(cards.map((c) => c.type), ["question"]);
  assert.deepEqual(await planActions({ groceries: [], notes: [] }, household()), []);
});
