import { test } from "node:test";
import assert from "node:assert/strict";
import type { Household, Llm } from "../contracts.ts";
import household from "../../fixtures/household.json" with { type: "json" };
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
