import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIETS, GOALS, LANGS, MEAL_CHOICES, UNITS, WEEKDAYS } from "./contracts.ts";
import type { ActionCard, CallInput, CallResult, Household, Lang, Llm, Stt } from "./contracts.ts";
import { matchesHouseholdBill, priceCart, requestsFromCart, reviewOf } from "./actions/cart.ts";
import { groceryPlan, quantityQuestion, spokenOption } from "./actions/plan.ts";
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

async function withAudio<T>(req: Request, read: (path: string) => Promise<T>): Promise<T> {
  const path = join(tmpdir(), `vfi-${randomUUID()}.${extFor(req.get("content-type"))}`);
  try {
    await writeFile(path, req.body);
    return await read(path);
  } finally {
    await rm(path, { force: true });
  }
}

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
  const statusOf = (e: Entry) => (!e.done ? "pending" : e.card.type === "question" || e.card.type === "meal-plan" ? "answered" : "approved");
  const withStatus = ({ call, entries }: StoredCall) => ({ ...call, status: Object.fromEntries(entries.map((e) => [e.card.id, statusOf(e)])) });

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
      result = await withAudio(req, audioPath => processCall({ audioPath, householdId, lang }, ctx, { stt, llm }, options));
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
    const { questions } = groceryPlan(extraction as ExtractionWithAmbiguous, ctx);
    let q = 0;
    for (const card of result.actions) {
      const entry: Entry = { card, callId, householdId, done: false };
      if (card.type === "question") {
        const question = questions[q++];
        entry.choices = question?.choices;
        entry.heldIndex = question?.heldIndex;
      }
      store.addAction(entry);
    }
    res.status(201).json(withStatus(store.call(callId)!));
  });

  app.get("/households/:id/actions", (req, res) => {
    if (!store.household(req.params.id)) return void res.status(404).json({ error: "unknown household" });
    res.json(store.looseActions(req.params.id).map((e) => ({ card: e.card, status: statusOf(e), at: e.at })));
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

  app.post("/actions/:id/review", (req, res) => {
    const entry = store.action(req.params.id);
    if (!entry || entry.card.type !== "cart") return void res.status(404).json({ error: "unknown cart" });
    const { card } = entry;
    const current = reviewOf(card.cart);
    if (entry.done || current.reviewId !== req.body?.reviewId) return void res.status(409).json({ error: "Reload the latest cart before editing." });
    const edits: unknown = req.body?.edits;
    if (!Array.isArray(edits) || !edits.length) return void res.status(400).json({ error: "Cart edits required." });
    const lines = requestsFromCart(current);
    const changed = new Set<number>();
    for (const edit of edits) {
      if (!edit || !Number.isInteger(edit.index) || !lines[edit.index] || changed.has(edit.index) ||
          !num(edit.qty) || !oneOf(UNITS, edit.unit)) return void res.status(400).json({ error: "Invalid cart edit." });
      if (edit.unit === "kg" && edit.qty > 2) return void res.status(422).json({ error: "Household limit is 2 kg per item." });
      changed.add(edit.index);
      lines[edit.index] = { ...lines[edit.index]!, qty: edit.qty, unit: edit.unit, interpretation: undefined };
    }
    const household = store.household(entry.householdId)!;
    const next = priceCart(lines.filter(l => l.qty > 0), household);
    if (next.held.length || !next.lines.length) {
      return void res.status(422).json({ error: next.held[0]?.reason ?? "Choose a household quantity and keep at least one item." });
    }
    next.held = current.held ?? [];
    card.cart = next;
    card.needsApproval = next.total > household.approvalLimit;
    store.saveAction(entry);
    res.json({ cart: card });
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
    if (card.type === "cart" || card.type === "order") {
      const cart = reviewOf(card.type === "cart" ? card.cart : card.order.cart);
      if (!entry.done && !matchesHouseholdBill(cart)) return void res.status(409).json({ error: "Review the current quantities and prices." });
      if ((req.body?.reviewId !== undefined || (card.type === "order" && cart.reviewId && !entry.done))
          && cart.reviewId !== req.body?.reviewId) {
        return void res.status(409).json({ error: "Cart changed. Review the current bill before confirming." });
      }
    }
    if (!entry.done && card.type === "cart" && want === undefined) {
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
      const saved = reviewOf(card.plan.cook.cart);
      const cart = saved.reviewId ? saved : priceCart(requestsFromCart(saved), household);
      const fresh: ActionCard = { id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit };
      store.addAction({ card: fresh, householdId: household.id, done: false });
      for (const issue of cart.held ?? []) {
        const question = quantityQuestion(issue, household);
        store.addAction({ ...question, cartId: fresh.id, householdId: household.id, done: false });
      }
      return void res.json({ status: "answered", cart: fresh });
    }
    if (card.type !== "question" || !choices) return void res.status(400).json({ error: "only questions can be answered" });
    if (entry.done) return void res.status(409).json({ error: "already answered" });
    let option: unknown = req.body?.option;
    if (Buffer.isBuffer(req.body)) {
      if (!req.body.length) return void res.status(400).json({ error: "empty audio body" });
      const lang = store.household(entry.householdId)!.cook.lang;
      const transcript = await withAudio(req, path => stt.transcribe(path, { lang, keywords: card.options }));
      const current = store.action(card.id);
      if (!current || current.done || JSON.stringify(current.card) !== JSON.stringify(card)) {
        return void res.status(409).json({ error: "This question has changed." });
      }
      option = spokenOption(card, choices, transcript.text);
      if (!option) return void res.status(422).json({ error: "Please tap one of the choices." });
    }
    if (typeof option !== "string" || !card.options.includes(option)) {
      return void res.status(400).json({ error: `option must be one of ${JSON.stringify(card.options)}` });
    }
    const line = choices[card.options.indexOf(option)];
    const { callId, householdId } = entry;
    const related = entry.cartId ? store.action(entry.cartId) : callId && store.call(callId)?.entries.find(e => e.card.type === "cart" && !e.done);
    const cartEntry = related && !related.done ? related : undefined;
    const previous = cartEntry?.card.type === "cart" ? reviewOf(cartEntry.card.cart) : undefined;
    const held = (previous?.held ?? []).filter(h => h.index !== entry.heldIndex);
    if (!line) {
      if (previous && cartEntry && held.length !== previous.held?.length) {
        previous.held = held;
        previous.reviewId = randomUUID();
        store.saveAction(cartEntry);
      }
      entry.done = true;
      store.saveAction(entry);
      return void res.json({ status: "answered" });
    }
    const lines = [...(previous ? requestsFromCart(previous) : []), { ...line, confidence: 1 }];
    const household = store.household(householdId)!;
    const next = groceryPlan({ groceries: lines, notes: [] }, household);
    if (next.questions.length) {
      const followUp = next.questions[0]!;
      entry.card = { ...followUp.card, id: card.id };
      entry.choices = followUp.choices;
      store.saveAction(entry);
      return void res.status(422).json({ error: followUp.card.text, question: entry.card });
    }
    next.cart.held = held;
    const fresh: ActionCard = { id: cartEntry?.card.id ?? randomUUID(), type: "cart", cart: next.cart, needsApproval: next.cart.total > household.approvalLimit };
    entry.done = true;
    store.saveAction(entry);
    if (cartEntry) {
      cartEntry.card = fresh;
      store.saveAction(cartEntry);
    } else {
      store.addAction({ card: fresh, callId, householdId, done: false }, { first: true });
    }
    res.json({ status: "answered", cart: cartEntry?.card ?? fresh });
  });

  app.post("/households", (req, res) => {
    const parsed = parseSignup(req.body);
    if (typeof parsed === "string") return void res.status(400).json({ error: parsed });
    const id = randomUUID();
    const household: Household = { id, ...parsed, pantry: {}, platform: "mock", history: [] };
    const ownerToken = randomBytes(32).toString("base64url");
    let cookCode: string;
    do cookCode = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    while (!store.addHousehold(household, cookCode, ownerToken));
    res.set("cache-control", "no-store").status(201).json({ id, cookCode, ownerToken, instamartAvailable: false });
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
