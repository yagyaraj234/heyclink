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

test("buildCart prices grams of a per-bunch item as one bunch, not one bunch per gram (meal-plan cook cart)", async () => {
  const lines: GroceryLine[] = [
    { raw: "150 g spinach", item: "spinach", qty: 150, unit: "g", confidence: 1 },
    { raw: "10 g coriander", item: "coriander", qty: 10, unit: "g", confidence: 1 },
    { raw: "do gaddi palak", item: "spinach", qty: 2, unit: "bunch", confidence: 1 },
  ];
  const cart = await buildCart(lines, household());
  // palak Rs 20 a bunch, coriander Rs 15 a bunch; bunches asked as bunches still count
  assert.deepEqual(cart.lines.map((l) => l.price), [20, 15, 40]);
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

test("buildCart prices brand ids as extraction emits them (Tata tea and dal are just 'tata')", async () => {
  const lines: GroceryLine[] = [
    { raw: "aadha kilo Tata Tea", item: "tea", qty: 500, unit: "g", brand: "tata", confidence: 1 },
    { raw: "ek kilo Tata toor dal", item: "toor-dal", qty: 1, unit: "kg", brand: "tata", confidence: 1 },
  ];
  const cart = await buildCart(lines, household());
  // tea 500 g / 250 g packs = 2 × tata 135 = 270 (base would be 280); toor dal 1 kg × tata 189 (base 165)
  assert.deepEqual(cart.lines.map((l) => l.price), [270, 189]);
  assert.equal(cart.lines[0]?.searchUrl, "https://www.swiggy.com/instamart/search?query=tata%20tea");
});

test("buildCart search links drop the catalog's bracketed gloss: 'Jeera (Cumin Seeds)' searches 'jeera'", async () => {
  const cart = await buildCart([
    { raw: "dhai sau gram jeera", item: "cumin-seeds", qty: 250, unit: "g", confidence: 1 },
    { raw: "aadha kilo bhindi", item: "okra", qty: 500, unit: "g", confidence: 1 },
  ], household());
  assert.deepEqual(cart.lines.map((l) => l.searchUrl), [
    "https://www.swiggy.com/instamart/search?query=jeera",
    "https://www.swiggy.com/instamart/search?query=bhindi",
  ]);
});

test("planActions asks which item a fuzzy word meant, with catalog names plus Skip", async () => {
  // extraction.ambiguous is lane 1's pending field, typed locally in plan.ts until it lands
  const extraction: Extraction & { ambiguous: { raw: string; qty: number; unit: "kg" | "g"; candidates: string[] }[] } = {
    groceries: [],
    notes: [],
    ambiguous: [
      { raw: "चना", qty: 1, unit: "kg", candidates: ["kabuli-chana", "kala-chana"] },
      { raw: "dal", qty: 500, unit: "g", candidates: ["toor-dal", "moong-dal"] },
    ],
  };
  const cards = await planActions(extraction, household());
  assert.deepEqual(cards.map((c) => c.type === "question" && [c.text, c.options]), [
    ['Which one did Lakshmi mean by "चना"? (1 kg)', ["Kabuli Chana", "Kala Chana", "Skip"]],
    ['Which one did Lakshmi mean by "dal"? (500 g)', ["Toor Dal", "Moong Dal", "Skip"]],
  ]);
});

test("buildCart interprets 500 kg onions as one 500 g pack and explains the change", async () => {
  const cart = await buildCart([{ raw: "500 kilo pyaaz", item: "onion", qty: 500, unit: "kg", confidence: 1 }], household());
  const line = cart.lines[0]!;
  assert.deepEqual([line.qty, line.unit, line.price], [500, "g", 22]);
  assert.deepEqual(line.pack, { count: 1, size: 500, unit: "g" });
  assert.match(line.interpretation ?? "", /500 kg.*500 g/);
});

test("buildCart counts actual packs across brands and holds bulk or unpriceable lines without dropping safe items", async () => {
  const line = (item: string, qty: number, unit: GroceryLine["unit"], brand?: string): GroceryLine =>
    ({ item, raw: item, qty, unit, confidence: 1, brand });
  const cart = await buildCart([
    line("onion", 1250, "g"), line("onion", 1, "kg", "other"), line("rice", 3, "packet"),
    line("eggs", 500, "piece"), line("mint", 25, "bunch"), line("unknown", 1, "packet"),
    line("atta", 2, "kg"), line("tea", -1, "g"),
  ], household());
  assert.deepEqual(cart.lines.map(l => [l.item, l.pack.count]), [["onion", 3], ["atta", 2]]);
  assert.deepEqual(cart.held.map(l => l.item), ["onion", "rice", "eggs", "mint", "unknown", "tea"]);
});

test("buildCart holds unclear pack units and bulk volume even for goods priced by the bunch", async () => {
  const lines: GroceryLine[] = [
    { item: "coriander", raw: "500 l dhaniya", qty: 500, unit: "l", confidence: 1 },
    { item: "onion", raw: "two bunch onions", qty: 2, unit: "bunch", confidence: 1 },
    { item: "eggs", raw: "aadha anda", qty: 0.5, unit: "piece", confidence: 1 },
  ];
  const cart = await buildCart(lines, household());
  assert.equal(cart.lines.length, 0);
  assert.equal(cart.held.length, 3);
});
