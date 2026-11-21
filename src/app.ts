import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomInt, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIETS, GOALS, LANGS, MEAL_CHOICES, WEEKDAYS } from "./contracts.ts";
import type { ActionCard, CallInput, CallResult, GroceryLine, Household, Lang, Llm, Stt } from "./contracts.ts";
import { cartCard, isUnsure } from "./actions/plan.ts";
import { planMeals } from "./pipeline/meals.ts";
import { placeOrder } from "./actions/orders.ts";
import { mockSwiggy } from "./actions/swiggy.ts";
import type { Swiggy } from "./actions/swiggy.ts";
import type { ExtractionWithAmbiguous, RecentCall } from "./actions/plan.ts";
import { openStore } from "./actions/store.ts";
import householdJson from "../fixtures/household.json" with { type: "json" };
import type { Entry, Store, StoredCall } from "./actions/store.ts";

/** Lane 1's processCall (src/pipeline/process.ts) satisfies this; tests inject it with fake ports. */
export type ProcessCall = (
  input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }, options?: { harness?: boolean; recent?: RecentCall[] },
) => Promise<CallResult>;

export interface AppDeps {
  processCall: ProcessCall;
  stt: Stt;
  llm: Llm;
  corsOrigin?: string; // default "*": the API has no cookies or auth
  webDir?: string; // built web UI, served after the API routes; a missing dir just 404s
  health?: { stt: string; llm: string }; // names only, never keys; GET /health reports them
  store?: Store; // default: a fresh in-memory database
  swiggy?: Swiggy; // places approved orders; default: labelled mock orders
}

// STT providers sniff format from the file extension. The header is client input: anything but a plain token → "bin".
const EXT: Record<string, string> = { mpeg: "mp3", mp4: "m4a", wave: "wav", "vnd.wave": "wav" };
const extFor = (contentType = "") => {
  const sub = contentType.split(";")[0]!.split("/")[1]?.trim().toLowerCase().replace(/^x-/, "") ?? "";
  const ext = EXT[sub] ?? sub;
  return /^[a-z0-9]+$/.test(ext) ? ext : "bin";
};

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: codes get read out loud

// Signup body is client input: rebuild it field by field so nothing unvalidated reaches the household.
type Signup = Pick<Household, "owner" | "cook" | "goals" | "family" | "brands" | "approvalLimit">;
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
function parseSignup(body: unknown): Signup | string {
  const { owner, cook, approvalLimit, brands = {}, goals, headcount = 1 } = (body ?? {}) as Record<string, any>; // any: unchecked JSON, narrowed below
  if (!str(owner?.name) || !str(owner?.phone)) return "owner needs name and phone";
  if (!str(cook?.name) || !oneOf(LANGS, cook?.lang) || !str(cook?.upiId) || !num(cook?.monthlySalary)) {
    return `cook needs name, lang (${LANGS.join("|")}), upiId and monthlySalary`;
  }
  if (cook.phone !== undefined && !str(cook.phone)) return "cook.phone must be a string";
  if (cook.offDays !== undefined && !(Array.isArray(cook.offDays) && cook.offDays.every((d: unknown) => oneOf(WEEKDAYS, d)))) {
    return `cook.offDays must be a list of ${WEEKDAYS.join("|")}`;
  }
  if (!num(approvalLimit)) return "approvalLimit must be a number ≥ 0";
  if (!brands || typeof brands !== "object" || !Object.values(brands).every(str)) return "brands must map item → brand";
  if (goals !== undefined && !(oneOf(GOALS, goals?.goal) && oneOf(DIETS, goals?.diet) && (goals.proteinG === undefined || num(goals.proteinG)))) {
    return `goals needs goal (${GOALS.join("|")}), diet (${DIETS.join("|")}) and optional proteinG`;
  }
  if (!Number.isInteger(headcount) || headcount < 1) return "headcount must be a whole number ≥ 1";
  return {
    owner: { name: owner.name, phone: owner.phone },
    cook: {
      name: cook.name, lang: cook.lang, upiId: cook.upiId, monthlySalary: cook.monthlySalary,
      ...(cook.phone && { phone: cook.phone }), ...(cook.offDays && { offDays: cook.offDays }),
    },
    ...(goals && { goals: { goal: goals.goal, diet: goals.diet, ...(goals.proteinG !== undefined && { proteinG: goals.proteinG }) } }),
    family: { headcount, dietRules: [] },
    brands: { ...brands },
    approvalLimit,
  };
}

export function createApp({ processCall, stt, llm, corsOrigin = "*", webDir = join(import.meta.dirname, "../web/dist"), health = { stt: "unknown", llm: "unknown" }, store = openStore(), swiggy = mockSwiggy }: AppDeps) {
  // CallResult (frozen) has no done flag, so responses add one status per action id.
  const withStatus = ({ call, entries }: StoredCall) => ({
    ...call,
    status: Object.fromEntries(entries.map((e) => [e.card.id, !e.done ? "pending" : e.card.type === "question" ? "answered" : "approved"])),
  });

  const app = express();
  app.use((req, res, next) => {
    res.set({
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      vary: "origin",
    });
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });
  app.use(express.json());
  app.use(express.raw({ type: "audio/*", limit: "25mb" }));

  app.get("/health", (_req, res) => void res.json({ ok: true, stt: health.stt, llm: health.llm }));

  app.post("/calls", async (req, res) => {
    const isAudio = Buffer.isBuffer(req.body);
    const body: { householdId?: unknown; transcript?: unknown; lang?: unknown } = isAudio ? {} : (req.body ?? {});
    const householdId = String(req.query.householdId ?? body.householdId ?? "");
    const household = store.household(householdId);
    if (!household) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    const lang: Lang | undefined = LANGS.find((l) => l === (req.query.lang ?? body.lang));
    // mode=plain: the base model (no household context, STT keywords or indic pass) for side-by-side demos.
    const mode = req.query.mode ?? "harness";
    if (mode !== "harness" && mode !== "plain") return void res.status(400).json({ error: "mode must be harness or plain" });
    const RECENT = 5;
    // harness only: the household's last calls, oldest → newest, so "woh wala" can refer back to them
    const options = mode !== "harness" ? { harness: false } : {
      harness: true,
      recent: store.calls(householdId, RECENT).reverse().map(({ call: c, at }): RecentCall => ({
        at,
        transcript: c.transcript.text,
        lines: c.extraction.groceries.map(({ item, qty, unit, brand }) => ({ item, qty, unit, ...(brand && { brand }) })),
      })),
    };
    // Plain also forgets household memory, so its cart gets no remembered brands. Cook, UPI and approval limit stay.
    const ctx: Household = options.harness ? household
      : { ...household, brands: {}, pantry: {}, history: [], family: { ...household.family, dietRules: [] } };

    let result: CallResult;
    if (isAudio) {
      if (!req.body.length) return void res.status(400).json({ error: "empty audio body" });
      const audioPath = join(tmpdir(), `vfi-${randomUUID()}.${extFor(req.get("content-type"))}`);
      await writeFile(audioPath, req.body);
      try {
        result = await processCall({ audioPath, householdId, lang }, ctx, { stt, llm }, options);
      } finally {
        await rm(audioPath, { force: true });
      }
    } else {
      const text = body.transcript;
      if (typeof text !== "string" || !text.trim()) {
        return void res.status(400).json({ error: "send audio/* or JSON { transcript, lang, householdId }" });
      }
      // Text input reuses the pipeline with an Stt that returns the given transcript; audioPath is unused.
      const textStt: Stt = { transcribe: async () => ({ text, lang: lang ?? household.cook.lang, provider: "fake" }) };
      result = await processCall({ audioPath: "", householdId, lang }, ctx, { stt: textStt, llm }, options);
    }
    // Plain results are for comparison only: never stored, so their cards can't be approved.
    if (!options.harness) return void res.json({ ...result, status: {} });

    store.addCall(result, householdId, new Date().toISOString());
    const { callId, extraction } = result;
    // question cards: unsure lines ("Yes, add it" | "No, skip"), then ambiguous words (candidates… | Skip); see planActions
    const choices: (GroceryLine | null)[][] = [
      ...extraction.groceries.filter(isUnsure).map((l) => [l, null]),
      ...((extraction as ExtractionWithAmbiguous).ambiguous ?? []).map(({ raw, qty, unit, candidates }) => [
        ...candidates.map((item) => ({ raw, item, qty, unit, confidence: 1 })),
        null,
      ]),
    ];
    let q = 0;
    for (const card of result.actions) {
      const entry: Entry = { card, callId, householdId, done: false };
      if (card.type === "cart") entry.lines = extraction.groceries.filter((l) => !isUnsure(l));
      if (card.type === "question") entry.choices = choices[q++];
      store.addAction(entry);
    }
    res.status(201).json(withStatus(store.call(callId)!));
  });

  app.get("/calls", (req, res) => {
    const householdId = String(req.query.householdId ?? "");
    if (!store.household(householdId)) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    res.json(store.calls(householdId).map(withStatus));
  });

  app.get("/calls/:id", (req, res) => {
    const stored = store.call(req.params.id);
    if (!stored) return void res.status(404).json({ error: "unknown call" });
    res.json(withStatus(stored));
  });

  app.post("/actions/:id/approve", async (req, res) => {
    const entry = store.action(req.params.id);
    if (!entry) return void res.status(404).json({ error: "unknown action" });
    const { card } = entry;
    if (card.type === "question" || card.type === "meal-plan") return void res.status(400).json({ error: `${card.type} cards are answered, not approved` });
    // { order: "now" | ISO time } on a cart → an order card; approving that card is the explicit confirmation
    const want: unknown = req.body?.order;
    let scheduledFor: string | undefined;
    if (want !== undefined) {
      if (card.type !== "cart") return void res.status(400).json({ error: "only carts can be ordered" });
      if (entry.done) return void res.status(409).json({ error: "cart already approved" });
      if (want !== "now") {
        const at = typeof want === "string" ? Date.parse(want) : NaN;
        if (Number.isNaN(at)) return void res.status(400).json({ error: 'order must be "now" or an ISO time' });
        scheduledFor = new Date(at).toISOString(); // UTC, so dueOrders can compare strings
      }
    }
    if (!entry.done && card.type === "cart") {
      const household = store.household(entry.householdId)!;
      household.history.push({
        at: new Date().toISOString().slice(0, 10),
        lines: card.cart.lines.map(({ item, qty, unit, brand }) => ({ item, qty, unit, ...(brand && { brand }) })),
      });
      store.saveHousehold(household);
    }
    entry.done = true;
    store.saveAction(entry);
    if (card.type === "cart" && want !== undefined) {
      const order: ActionCard = { id: randomUUID(), type: "order", order: { cart: card.cart, status: "scheduled", ...(scheduledFor && { scheduledFor }) }, needsApproval: true };
      store.addAction({ card: order, householdId: entry.householdId, callId: entry.callId, done: false });
      return void res.json({ status: "approved", order });
    }
    if (card.type === "order") {
      // no time = place now; a time = runDue places it once due
      if (card.order.status === "scheduled" && !card.order.scheduledFor && !entry.placing) await placeOrder(entry, store, swiggy);
      return void res.json({ status: "approved", order: card.order });
    }
    res.json({ status: "approved", ...(card.type === "advance" && card.upiUrl && { upiUrl: card.upiUrl }) });
  });

  app.post("/actions/:id/answer", async (req, res) => {
    const entry = store.action(req.params.id);
    if (!entry) return void res.status(404).json({ error: "unknown action" });
    const { card, choices } = entry;
    if (card.type === "meal-plan") {
      if (entry.done) return void res.status(409).json({ error: "already answered" });
      const option = MEAL_CHOICES.find((c) => c === req.body?.option);
      if (!option) return void res.status(400).json({ error: `option must be one of ${JSON.stringify(MEAL_CHOICES)}` });
      const household = store.household(entry.householdId)!;
      const day = WEEKDAYS[new Date(`${card.plan.date}T00:00:00Z`).getUTCDay()]!; // the date is a calendar day, not an instant
      const habit = (household.habits ??= {})[day] ??= { cook: 0, order: 0 };
      habit[option]++;
      store.saveHousehold(household);
      entry.done = true;
      store.saveAction(entry);
      if (option === "order") return void res.json({ status: "answered" });
      const { cart } = card.plan.cook; // already priced by planMeals; same approval rule as call carts
      const fresh: ActionCard = { id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit };
      store.addAction({ card: fresh, householdId: household.id, done: false });
      return void res.json({ status: "answered", cart: fresh });
    }
    if (card.type !== "question" || !choices) return void res.status(400).json({ error: "only questions can be answered" });
    if (entry.done) return void res.status(409).json({ error: "already answered" });
    const option: unknown = req.body?.option;
    if (typeof option !== "string" || !card.options.includes(option)) {
      return void res.status(400).json({ error: `option must be one of ${JSON.stringify(card.options)}` });
    }
    const line = choices[card.options.indexOf(option)];
    if (!line) {
      entry.done = true;
      store.saveAction(entry);
      return void res.json({ status: "answered" });
    }

    const { callId, householdId } = entry;
    const cartEntry = store.call(callId!)!.entries.find((e) => e.card.type === "cart");
    if (cartEntry?.done) return void res.status(409).json({ error: "cart already approved" });
    const lines = [...(cartEntry?.lines ?? []), line];
    const fresh = await cartCard(lines, store.household(householdId)!);
    // the cart may have been approved during the await; saving our stale copy would undo that
    if (cartEntry && store.action(cartEntry.card.id)!.done) return void res.status(409).json({ error: "cart already approved" });
    entry.done = true;
    store.saveAction(entry);
    if (cartEntry) {
      Object.assign(cartEntry.card, { cart: fresh.cart, needsApproval: fresh.needsApproval });
      cartEntry.lines = lines;
      store.saveAction(cartEntry);
    } else {
      store.addAction({ card: fresh, callId, householdId, done: false, lines }, { first: true });
    }
    res.json({ status: "answered", cart: cartEntry?.card ?? fresh });
  });

  app.post("/households", (req, res) => {
    const parsed = parseSignup(req.body);
    if (typeof parsed === "string") return void res.status(400).json({ error: parsed });
    const id = randomUUID();
    const household: Household = { id, ...parsed, pantry: {}, platform: "mock", history: [] };
    let cookCode: string;
    do cookCode = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    while (!store.addHousehold(household, cookCode));
    res.status(201).json({ id, cookCode });
  });

  app.post("/join", (req, res) => {
    const household = store.householdByCode(String(req.body?.code ?? "").trim().toUpperCase());
    if (!household) return void res.status(404).json({ error: "unknown code" });
    res.json({ householdId: household.id, role: "cook", cook: { name: household.cook.name, lang: household.cook.lang } });
  });

  app.post("/households/:id/meal-plan", async (req, res) => {
    const household = store.household(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    const DAY = 86_400_000, IST = 5.5 * 3_600_000;
    const date: unknown = req.body?.date ?? new Date(Date.now() + IST + DAY).toISOString().slice(0, 10);
    if (typeof date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date))) {
      return void res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const card: ActionCard = { id: randomUUID(), type: "meal-plan", plan: await planMeals(household, date, { llm }), options: [...MEAL_CHOICES] };
    store.addAction({ card, householdId: household.id, done: false });
    res.status(201).json(card);
  });

  app.get("/households/:id", (req, res) => {
    const household = store.household(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    res.json(household);
  });

  // ponytail: unauthenticated, like the rest of the demo API; anyone with the URL can reset h1.
  app.post("/households/:id/reset", (req, res) => {
    if (req.params.id !== householdJson.id) return void res.status(404).json({ error: "only the demo household can be reset" });
    store.resetDemo();
    res.json({ status: "reset" });
  });

  app.use(express.static(webDir));

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
