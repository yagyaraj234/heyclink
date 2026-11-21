import { test } from "node:test";
import assert from "node:assert/strict";
import type { GroceryLine, Household } from "../contracts.ts";
import householdJson from "../../fixtures/household.json" with { type: "json" };
import items from "../../fixtures/items.json" with { type: "json" };
import case01 from "../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import case02 from "../../fixtures/cases/cook-hinglish-02.json" with { type: "json" };
import { buildCart } from "./cart.ts";

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
