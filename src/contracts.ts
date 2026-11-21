// FROZEN CONTRACTS. Every lane builds against these types and the fixtures/.
// Change only via a dedicated PR the integrator approves; never inside a lane PR.

export const LANGS = ["hi", "te", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const STT_PROVIDERS = ["openai", "sarvam", "whisper-cpp", "fake"] as const;
export type SttProvider = (typeof STT_PROVIDERS)[number];

export const UNITS = ["kg", "g", "l", "ml", "packet", "piece", "dozen", "bunch"] as const;
export type Unit = (typeof UNITS)[number];

// ---- Pipeline ---------------------------------------------------------------

export interface CallInput {
  audioPath: string;
  householdId: string;
  lang?: Lang; // hint; providers may auto-detect
}

export interface Transcript {
  text: string;
  lang: Lang;
  provider: SttProvider;
}

/** One grocery request. `item` is a canonical id from src/indic lexicon, e.g. "onion", "atta", "coriander". */
export interface GroceryLine {
  raw: string; // span as heard, e.g. "do kilo pyaaz"
  item: string;
  qty: number;
  unit: Unit;
  brand?: string; // canonical brand id, e.g. "aashirvaad"
  confidence: number; // 0..1
}

export interface AdvanceRequest {
  amount: number; // INR
  reason?: string;
}

export interface Extraction {
  groceries: GroceryLine[];
  advance?: AdvanceRequest;
  notes: string[]; // anything said that is not an action (e.g. "kal 8 baje aaungi")
}

export interface CallResult {
  callId: string;
  transcript: Transcript;
  extraction: Extraction;
  actions: ActionCard[];
  timings: StageTimings;
}

/** Wall-clock ms per stage for one call. totalMs = audio received → ActionCards ready (agent response latency). */
export interface StageTimings {
  sttMs: number;
  extractMs: number;
  planMs: number;
  totalMs: number;
}

export interface LatencySummary {
  n: number;
  p50: number;
  p95: number;
  p99: number;
}

// ---- Actions ----------------------------------------------------------------

export const PLATFORMS = ["instamart", "mock"] as const;
export type Platform = (typeof PLATFORMS)[number];

export interface CartLine {
  item: string;
  qty: number;
  unit: Unit;
  brand?: string;
  price: number; // INR, line total
  searchUrl: string;
}

export interface Cart {
  lines: CartLine[];
  total: number; // INR
  platform: Platform;
  checkoutUrl?: string;
  upiUrl?: string;
}

export type ActionCard =
  | { id: string; type: "cart"; cart: Cart; needsApproval: boolean }
  | { id: string; type: "advance"; advance: AdvanceRequest; payee: string; upiUrl?: string; needsApproval: true }
  | { id: string; type: "question"; text: string; options: string[] }
  | { id: string; type: "order"; order: Order; needsApproval: true }
  | { id: string; type: "meal-plan"; plan: MealPlan; options: MealChoice[] };

// ---- Kitchen: orders and meal plans -----------------------------------------

export const ORDER_STATUSES = ["scheduled", "placed", "failed", "cancelled"] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];

/** An Instamart order. cart.platform "instamart" = placed through Swiggy; "mock" = labelled demo order. Payment is COD only. */
export interface Order {
  cart: Cart;
  status: OrderStatus;
  scheduledFor?: string; // ISO time the scheduler places it; absent = place on approve
  orderId?: string; // Swiggy order id once placed
}

export const MEAL_SLOTS = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealSlot = (typeof MEAL_SLOTS)[number];

export const MEAL_CHOICES = ["cook", "order"] as const;
export type MealChoice = (typeof MEAL_CHOICES)[number];

/** LLM estimates per serving; the UI always shows them with "≈". */
export interface Macros { kcal: number; proteinG: number; carbsG: number; fiberG: number; fatG: number }

export interface Meal {
  slot: MealSlot;
  dish: string;
  macros: Macros;
  steps?: string[]; // cook option: short recipe
  searchUrl?: string; // order option: Swiggy search for the dish
}

/** Tomorrow's plan, e.g. when the cook is off. Both options are filled; `suggested` comes from habits. */
export interface MealPlan {
  date: string; // YYYY-MM-DD the plan is for
  reason: string; // e.g. "Lakshmi is off on Sunday"
  suggested: MealChoice;
  cook: { meals: Meal[]; cart: Cart }; // cart = ingredients not already in the pantry
  order: { meals: Meal[] };
}

// ---- Household context ------------------------------------------------------

export interface Household {
  id: string;
  cook: { name: string; lang: Lang; monthlySalary: number; upiId: string; phone?: string; offDays?: Weekday[] };
  owner?: { name: string; phone: string };
  goals?: { goal: Goal; diet: Diet; proteinG?: number }; // from signup; feeds meal plans
  family: { headcount: number; dietRules: string[] };
  brands: Record<string, string>; // item -> preferred brand
  pantry: Record<string, { qty: number; unit: Unit }>;
  platform: Platform;
  approvalLimit: number; // INR; carts above this need approval
  history: { at: string; lines: Pick<GroceryLine, "item" | "qty" | "unit" | "brand">[] }[];
  habits?: Partial<Record<Weekday, Record<MealChoice, number>>>; // meal-plan choices per weekday, e.g. { sun: { cook: 1, order: 3 } }
}

export const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const GOALS = ["lose", "maintain", "gain"] as const;
export type Goal = (typeof GOALS)[number];
export const DIETS = ["veg", "egg", "non-veg"] as const;
export type Diet = (typeof DIETS)[number];

// ---- Ports (external adapters; the ONLY place tests may use fakes) ----------

export interface Stt {
  transcribe(audioPath: string, opts: { lang?: Lang; keywords: string[] }): Promise<Transcript>;
}

export interface Llm {
  /** Returns JSON matching `schema` (OpenAI structured outputs). */
  json<T>(args: { system: string; user: string; schema: object; schemaName: string }): Promise<T>;
}
