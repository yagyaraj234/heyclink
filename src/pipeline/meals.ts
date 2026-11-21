import type { GroceryLine, Household, Llm, Macros, MealChoice, MealPlan, Unit, Weekday } from "../contracts.ts";
import { UNITS, WEEKDAYS } from "../contracts.ts";
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { buildCart } from "../actions/cart.ts";

const DAY_NAMES: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

interface LlmMeal {
  slot: "breakfast" | "lunch" | "dinner";
  dish: string;
  macros: Macros;
}
interface LlmPlan {
  cook: { meals: (LlmMeal & { steps: string[]; ingredients: { item: string; qty: number; unit: Unit }[] })[] };
  order: { meals: LlmMeal[] };
}

const obj = (properties: Record<string, object>, description?: string) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
  ...(description && { description }),
});
const num = { type: "number" };
const meal = {
  slot: { type: "string", enum: ["breakfast", "lunch", "dinner"] },
  dish: { type: "string", description: "short dish name, e.g. 'Palak paneer with roti'" },
  macros: obj({ kcal: num, proteinG: num, carbsG: num, fiberG: num, fatG: num }, "per serving, estimated"),
};

export const MEAL_SCHEMA = obj({
  cook: obj({ meals: { type: "array", items: obj({ ...meal, steps: { type: "array", items: { type: "string" }, description: "3-5 short recipe steps for the cook" },
    ingredients: {
      type: "array",
      items: obj({ item: { type: "string", enum: ITEMS }, qty: num, unit: { type: "string", enum: UNITS } }),
      description: "catalog ingredients to buy for the whole family; skip salt, water and spices not in the list",
    },
  }) } }),
  order: obj({ meals: { type: "array", items: obj(meal) }, }, "dishes easy to order from a restaurant"),
});

const SYSTEM = `You plan one day of Indian home meals for a family: breakfast, lunch and dinner, twice.
- cook: dishes the household cook makes at home.
- order: dishes to order from a restaurant instead.
- Follow every diet rule and the diet type (veg: no meat, fish or egg; egg: veg plus eggs). Macros are per serving.
- Aim to hit the daily protein and fiber targets across the three meals; for a "lose" goal keep meals light (lower kcal, less oil).`;

function householdBrief(h: Household): string {
  const g = h.goals;
  return [
    `Family: ${h.family.headcount} people`,
    `Diet rules: ${h.family.dietRules.join("; ") || "none"}`,
    g && `Diet: ${g.diet}. Goal: ${g.goal}${g.proteinG ? `, ${g.proteinG} g protein per person per day` : ""}`,
  ].filter(Boolean).join("\n");
}

function weekday(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!; // UTC: the date is a calendar day, not an instant
}

/** Habits win; with no habit (or a tie) the cook's off day decides. */
function suggest(h: Household, day: Weekday): { suggested: MealChoice; reason: string } {
  const off = h.cook.offDays?.includes(day) ?? false;
  const habit = h.habits?.[day];
  const parts = off ? [`${h.cook.name} is off on ${DAY_NAMES[day]}`] : [];
  // ponytail: a cook/order tie falls back to the off-day rule
  let suggested: MealChoice = off ? "order" : "cook";
  if (habit && habit.order !== habit.cook) {
    suggested = habit.order > habit.cook ? "order" : "cook";
    parts.push(`you usually ${suggested} on ${DAY_NAMES[day]}s`);
  }
  const reason = parts.join("; ");
  return { suggested, reason: reason.charAt(0).toUpperCase() + reason.slice(1) || `Plan for ${DAY_NAMES[day]}` };
}

/** Ingredients summed per item and unit, minus what the pantry already holds. */
function shoppingLines(plan: LlmPlan, h: Household): GroceryLine[] {
  const sum = new Map<string, GroceryLine>();
  for (const { item, qty, unit } of plan.cook.meals.flatMap((m) => m.ingredients)) {
    if ((h.pantry[item]?.qty ?? 0) > 0) continue; // ponytail: any stock counts as enough
    const key = `${item}|${unit}`; // ponytail: 500 g and 1 kg of one item stay two lines
    const line = sum.get(key);
    if (line) line.qty += qty;
    else sum.set(key, { raw: item, item, qty, unit, confidence: 1 });
  }
  return [...sum.values()];
}

export async function planMeals(household: Household, date: string, ports: { llm: Llm }): Promise<MealPlan> {
  const day = weekday(date);
  const out = await ports.llm.json<LlmPlan>({
    system: SYSTEM,
    user: `${householdBrief(household)}\nDate: ${date} (${DAY_NAMES[day]})`,
    schema: MEAL_SCHEMA,
    schemaName: "meal_plan",
  });
  return {
    date,
    ...suggest(household, day),
    cook: { meals: out.cook.meals.map(({ slot, dish, macros, steps }) => ({ slot, dish, macros, steps })), cart: await buildCart(shoppingLines(out, household), household) },
    order: { meals: out.order.meals.map(({ slot, dish, macros }) => ({ slot, dish, macros, searchUrl: `https://www.swiggy.com/search?query=${encodeURIComponent(dish)}` })) },
  };
}
