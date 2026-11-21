import { test } from "node:test";
import assert from "node:assert/strict";
import type { Household, Llm } from "../contracts.ts";
import household from "../../fixtures/household.json" with { type: "json" };
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { planMeals } from "./meals.ts";

const h = household as Household;
const SUNDAY = "2026-11-22";

const macros = (kcal: number, proteinG: number) => ({ kcal, proteinG, carbsG: 40, fiberG: 8, fatG: 12 });
const reply = {
  cook: {
    meals: [
      { slot: "breakfast", dish: "Moong dal chilla", macros: macros(320, 18), steps: ["Soak dal", "Grind", "Cook on tawa"], ingredients: [{ item: "moong-dal", qty: 300, unit: "g" }] },
      { slot: "lunch", dish: "Palak paneer with roti", macros: macros(520, 28), steps: ["Blanch palak", "Add paneer", "Make roti"], ingredients: [{ item: "paneer", qty: 400, unit: "g" }, { item: "atta", qty: 500, unit: "g" }] },
      { slot: "dinner", dish: "Dal khichdi", macros: macros(450, 20), steps: ["Wash rice and dal", "Pressure cook", "Temper"], ingredients: [{ item: "rice", qty: 300, unit: "g" }, { item: "onion", qty: 2, unit: "piece" }] },
    ],
  },
  order: {
    meals: [
      { slot: "breakfast", dish: "Idli sambar", macros: macros(300, 10) },
      { slot: "lunch", dish: "Paneer tikka bowl", macros: macros(600, 32) },
      { slot: "dinner", dish: "Veg thali", macros: macros(700, 22) },
    ],
  },
};

function fakeLlm(r: unknown = reply) {
  const calls: { system: string; user: string; schema: object }[] = [];
  const llm: Llm = {
    async json<T>(args: { system: string; user: string; schema: object; schemaName: string }) {
      calls.push(args);
      return r as T;
    },
  };
  return { llm, calls };
}

test("planMeals: suggested follows the household's habit for that weekday, and the reason says so", async () => {
  const hh: Household = { ...h, habits: { sun: { cook: 1, order: 3 } } };
  const { llm } = fakeLlm();

  const plan = await planMeals(hh, SUNDAY, { llm });

  assert.equal(plan.date, SUNDAY);
  assert.equal(plan.suggested, "order");
  assert.match(plan.reason, /usually order on Sundays/);
});

test("planMeals: with no habits, order on the cook's off day and cook otherwise", async () => {
  const hh: Household = { ...h, cook: { ...h.cook, offDays: ["sun"] } };

  const sunday = await planMeals(hh, SUNDAY, { llm: fakeLlm().llm });
  const monday = await planMeals(hh, "2026-11-23", { llm: fakeLlm().llm });

  assert.equal(sunday.suggested, "order");
  assert.equal(sunday.reason, "Lakshmi is off on Sunday");
  assert.equal(monday.suggested, "cook");
});

test("planMeals: the cook cart holds the dishes' ingredients minus pantry items in stock (onion), priced from the catalog", async () => {
  const plan = await planMeals(h, SUNDAY, { llm: fakeLlm().llm });

  // pantry: onion 1 kg (skip), atta 0 kg (buy), milk (not used)
  assert.deepEqual(plan.cook.cart.lines.map((l) => [l.item, l.qty, l.unit]), [
    ["moong-dal", 300, "g"],
    ["paneer", 400, "g"],
    ["atta", 500, "g"],
    ["rice", 300, "g"],
  ]);
  assert.ok(plan.cook.cart.lines.every((l) => l.price > 0));
  assert.equal(plan.cook.cart.lines.find((l) => l.item === "atta")?.brand, "aashirvaad");
  assert.deepEqual(Object.keys(plan.cook.meals[1]!).sort(), ["dish", "macros", "slot", "steps"]);
});

test("planMeals: diet rules, goals and headcount reach the LLM; ingredients are catalog ids", async () => {
  const hh: Household = { ...h, goals: { goal: "lose", diet: "veg", proteinG: 90 } };
  const { llm, calls } = fakeLlm();

  await planMeals(hh, SUNDAY, { llm });

  const prompt = calls[0]!.system + "\n" + calls[0]!.user;
  assert.match(prompt, /no onion on Tuesdays/);
  assert.match(prompt, /papa diabetic: low sugar/);
  assert.match(prompt, /\bveg\b/);
  assert.match(prompt, /90 ?g protein/);
  assert.match(prompt, /light/i);
  assert.match(prompt, /protein and fiber/);
  assert.match(prompt, /4 people/);
  const schema = calls[0]!.schema as any; // any: walking a JSON schema literal
  assert.deepEqual(schema.properties.cook.properties.meals.items.properties.ingredients.items.properties.item.enum, ITEMS);
});
