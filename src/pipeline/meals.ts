import type { Household, Llm, Macros, MealChoice, MealPlan, Weekday } from "../contracts.ts";
import { WEEKDAYS } from "../contracts.ts";

const DAY_NAMES: Record<Weekday, string> = { sun: "Sunday", mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday" };

interface LlmMeal {
  slot: "breakfast" | "lunch" | "dinner";
  dish: string;
  macros: Macros;
}
interface LlmPlan {
  cook: { meals: (LlmMeal & { steps: string[] })[] };
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
  cook: obj({ meals: { type: "array", items: obj({ ...meal, steps: { type: "array", items: { type: "string" }, description: "3-5 short recipe steps for the cook" } }) } }),
  order: obj({ meals: { type: "array", items: obj(meal) }, }, "dishes easy to order from a restaurant"),
});

const SYSTEM = `You plan one day of Indian home meals for a family: breakfast, lunch and dinner, twice.
- cook: dishes the household cook makes at home.
- order: dishes to order from a restaurant instead.
- Follow every diet rule. Macros are per serving.`;

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

export async function planMeals(household: Household, date: string, ports: { llm: Llm }): Promise<MealPlan> {
  const day = weekday(date);
  const out = await ports.llm.json<LlmPlan>({
    system: SYSTEM,
    user: `Date: ${date} (${DAY_NAMES[day]})`,
    schema: MEAL_SCHEMA,
    schemaName: "meal_plan",
  });
  return {
    date,
    ...suggest(household, day),
    cook: { meals: out.cook.meals.map(({ slot, dish, macros, steps }) => ({ slot, dish, macros, steps })), cart: { lines: [], total: 0, platform: household.platform } },
    order: { meals: out.order.meals.map(({ slot, dish, macros }) => ({ slot, dish, macros })) },
  };
}
