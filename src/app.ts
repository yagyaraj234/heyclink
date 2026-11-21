import { installAuth } from "./actions/auth.ts";
import type { AuthConfig } from "./actions/auth.ts";
import { instamartRouter } from "./actions/instamart.ts";
import type { InstamartConfig } from "./actions/instamart.ts";
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
import { wordKey } from "./pipeline/process.ts";
import { placeOrder } from "./actions/orders.ts";
import { mockSwiggy } from "./actions/swiggy.ts";
import type { Swiggy } from "./actions/swiggy.ts";
import type { ExtractionWithAmbiguous, RecentCall } from "./actions/plan.ts";
import { cartRevision, manualReceipt, recordPurchase } from "./actions/store.ts";
import householdJson from "../fixtures/household.json" with { type: "json" };
import type { Entry, Store, StoredCall } from "./actions/store.ts";

/** Lane 1's processCall (src/pipeline/process.ts) satisfies this; tests inject it with fake ports. */
export type ProcessCall = (
  input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }, options?: { harness?: boolean; recent?: RecentCall[]; words?: Record<string, string> },
) => Promise<CallResult>;

export interface AppDeps {
  processCall: ProcessCall;
  stt: Stt;
  llm: Llm;
  corsOrigin?: string;
  webDir?: string; // built web UI, served after the API routes; a missing dir just 404s
  health?: { stt: string; llm: string }; // names only, never keys; GET /health reports them
  store: Store;
  instamart?: InstamartConfig;
  auth?: AuthConfig;
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

/** A status and JSON body, decided inside a transaction and sent after it commits. No body: the bare status. */
type Reply = [number, unknown?];
const send = (res: Response, [status, body]: Reply) => void (body === undefined ? res.sendStatus(status) : res.status(status).json(body));

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: codes get read out loud

// Signup body is client input: rebuild it field by field so nothing unvalidated reaches the household.
type Signup = Pick<Household, "owner" | "cook" | "goals" | "family" | "brands" | "approvalLimit">;
const str = (v: unknown): v is string => typeof v === "string" && v.trim() !== "";
const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => list.includes(v as T);
function parseSignup(body: unknown, verifiedPhone?: string): Signup | string {
  const { owner, cook, approvalLimit, brands = {}, goals, headcount = 1 } = (body ?? {}) as Record<string, any>; // any: unchecked JSON, narrowed below
  if (!str(owner?.name) || (verifiedPhone === undefined && !str(owner?.phone))) return "owner needs name and phone";
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
    owner: { name: owner.name, phone: verifiedPhone ?? owner.phone },
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

function householdProfile(body: { name?: unknown; location?: unknown } | undefined) {
  const { name, location } = body ?? {};
  if (!str(name) || !str(location) || name.trim().length > 80 || location.trim().length > 120) return;
  return { name: name.trim(), location: location.trim() };
}

export function createApp({ processCall, stt, llm, corsOrigin = "*", webDir = join(import.meta.dirname, "../web/dist"), health = { stt: "unknown", llm: "unknown" }, store, swiggy = mockSwiggy, instamart, auth }: AppDeps) {
  // CallResult (frozen) has no done flag, so responses add one status per action id.
  const statusOf = (e: Entry) => (!e.done ? "pending" : e.card.type === "question" || e.card.type === "meal-plan" ? "answered" : "approved");
  const feedTracking = async (e: Entry, owner: boolean) => {
    const tracking = e.tracking;
    let receipt = tracking?.receipt;
    if (!e.done && e.card.type === "cart" && await store.instamartClaimed(e.card.id)) {
      receipt = await store.instamartReceipt(e.card.id, cartRevision(e.card.cart));
      if (!receipt) return owner ? {...tracking, instamartPending: true} : tracking;
    }
    if (!receipt) return tracking;
    if (owner) return {...tracking, receipt};
    const lines = receipt.lines.map(({price: _price, ...line}) => line);
    return {...tracking, receipt: {source: receipt.source, lines}};
  };
  const cookCard = (e: Entry) => {
    const card = e.card;
    if (card.type === "question") return card;
    if (card.type === "cart" && (e.tracking?.state || e.tracking?.receipt)) return { id: card.id, type: "cart" as const };
    if (card.type === "meal-plan" && e.selectedMeal) {
      return { id: card.id, type: "shared-meal" as const, date: card.plan.date, choice: e.selectedMeal,
        dishes: card.plan[e.selectedMeal].meals.map(({ slot, dish }) => ({ slot, dish })) };
    }
  };
  const withStatus = async ({call, entries}: StoredCall, owner = false, cook = false, submitted = false) => {
    if (cook) {
      const feed = (await Promise.all(entries.map(async e => {
        const card = cookCard(e);
        return card && { card, status: statusOf(e), tracking: await feedTracking(e, false) };
      }))).filter(e => e !== undefined);
      return {
        callId: call.callId, ...(submitted && { transcript: call.transcript, timings: call.timings }),
        actions: feed.map(e => e.card),
        status: Object.fromEntries(feed.map(e => [e.card.id, e.status])),
        tracking: Object.fromEntries(feed.filter(e => e.tracking).map(e => [e.card.id, e.tracking])),
      };
    }

    const tracking = Object.fromEntries((await Promise.all(entries.map(async e => {
      const value = await feedTracking(e, owner);
      return value ? [[e.card.id, value]] : [];
    }))).flat());
    return {...call, ...(Object.keys(tracking).length && {tracking}), status: Object.fromEntries(entries.map(e => [e.card.id, statusOf(e)]))};
  };

  const app = express();
  app.use((req, res, next) => {
    res.set({
      "access-control-allow-origin": corsOrigin,
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type, authorization",
      vary: "origin",
    });
    if (req.method === "OPTIONS") return void res.sendStatus(204);
    next();
  });
  app.use(express.json());
  const access = auth && installAuth(app, store, auth, !!instamart);
  const isOwner = (req: Request, householdId: string) =>
    access ? access.role(req) === "owner" : store.isOwner(householdId, req.get("authorization"));
  app.use(express.raw({ type: "audio/*", limit: "25mb" }));


  app.post(["/actions/:id/approve", "/actions/:id/review"], async (req, res, next) => {
    const entry = typeof req.params.id === "string" ? await store.action(req.params.id) : undefined;
    if (!access && entry && await store.hasOwnerKey(entry.householdId) && !await store.isOwner(entry.householdId, req.get("authorization"))) {
      return void res.status(403).json({error: "Owner confirmation required"});
    }
    next();
  });

  if (instamart) app.use(instamartRouter(instamart, store, access && (req => access.role(req) === "owner")));
  app.get("/health", (_req, res) => void res.json({ ok: true, stt: health.stt, llm: health.llm }));

  app.post("/calls", async (req, res) => {
    const isAudio = Buffer.isBuffer(req.body);
    const body: { householdId?: unknown; transcript?: unknown; lang?: unknown } = isAudio ? {} : (req.body ?? {});
    const householdId = String(req.query.householdId ?? body.householdId ?? "");
    const household = await store.household(householdId);
    if (!household) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    const lang: Lang | undefined = LANGS.find((l) => l === (req.query.lang ?? body.lang));
    // mode=plain: the base model (no household context, STT keywords or indic pass) for side-by-side demos.
    const mode = req.query.mode ?? "harness";
    if (mode === "plain" && access) return void res.sendStatus(404);
    if (mode !== "harness" && mode !== "plain") return void res.status(400).json({ error: "mode must be harness or plain" });
    const RECENT = 5;
    // harness only: the household's last calls, oldest → newest, so "woh wala" can refer back to them
    const options = mode !== "harness" ? { harness: false } : {
      harness: true,
      recent: (await store.calls(householdId, RECENT)).reverse().map(({ call: c, at }): RecentCall => ({
        at,
        transcript: c.transcript.text,
        lines: c.extraction.groceries.map(({ item, qty, unit, brand }) => ({ item, qty, unit, ...(brand && { brand }) })),
      })),
      words: await store.words(household),
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

    await store.addCall(result, householdId, new Date().toISOString());
    const { callId, extraction } = result;
    const { questions } = groceryPlan(extraction as ExtractionWithAmbiguous, ctx);
    let q = 0;
    for (const card of result.actions) {
      const entry: Entry = { card, callId, householdId, done: false };
      if (card.type === "question") {
        const question = questions[q++];
        entry.choices = question?.choices;
        entry.heldIndex = question?.heldIndex;
        if (question?.word) entry.word = wordKey(question.word);
      }
      await store.addAction(entry);
    }
    res.status(201).json(await withStatus((await store.call(callId))!, access?.role(req) === "owner", access?.role(req) === "cook", true));
  });

  app.get("/households/:id/actions", async (req, res) => {
    if (!await store.household(req.params.id)) return void res.status(404).json({ error: "unknown household" });
    const owner = await isOwner(req, req.params.id);
    const cook = access?.role(req) === "cook";
    res.json((await Promise.all((await store.looseActions(req.params.id)).map(async e => {
      const card = cook ? cookCard(e) : e.card;
      return card && {card, status: statusOf(e), at: e.at, tracking: await feedTracking(e, owner)};
    }))).filter(e => e !== undefined));
  });

  app.get("/calls", async (req, res) => {
    const householdId = String(req.query.householdId ?? "");
    if (!await store.household(householdId)) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    const owner = await isOwner(req, householdId);
    res.json(await Promise.all((await store.calls(householdId)).map(call => withStatus(call, owner, access?.role(req) === "cook"))));
  });

  app.get("/calls/:id", async (req, res) => {
    const stored = await store.call(req.params.id);
    if (!stored) return void res.status(404).json({ error: "unknown call" });
    const household = stored.entries[0]?.householdId;
    res.json(await withStatus(stored, access ? access.role(req) === "owner" : !!household && await isOwner(req, household), access?.role(req) === "cook"));
  });

  // Read → change → save routes run in a transaction holding the card's row lock (then its cart's, then the household's),
  // so the same edit on another instance waits instead of overwriting. Network calls (STT, checkout) stay outside it.
  app.post("/actions/:id/review", async (req, res) => send(res, await store.tx(async (): Promise<Reply> => {
    const entry = await store.lockedAction(req.params.id);
    if (!entry || entry.card.type !== "cart") return [404, { error: "unknown cart" }];
    const { card } = entry;
    const current = reviewOf(card.cart);
    if (entry.done || current.reviewId !== req.body?.reviewId) return [409, { error: "Reload the latest cart before editing." }];
    const edits: unknown = req.body?.edits;
    if (!Array.isArray(edits) || !edits.length) return [400, { error: "Cart edits required." }];
    const lines = requestsFromCart(current);
    const changed = new Set<number>();
    for (const edit of edits) {
      if (!edit || !Number.isInteger(edit.index) || !lines[edit.index] || changed.has(edit.index) ||
          !num(edit.qty) || !oneOf(UNITS, edit.unit)) return [400, { error: "Invalid cart edit." }];
      changed.add(edit.index);
      lines[edit.index] = { ...lines[edit.index]!, qty: edit.qty, unit: edit.unit, interpretation: undefined };
    }
    const household = (await store.household(entry.householdId))!;
    const next = priceCart(lines.filter(l => l.qty > 0), household, "owner");
    if (next.held[0]) return [422, { error: next.held[0].reason }];
    next.held = current.held ?? [];
    card.cart = next;
    card.needsApproval = next.total > household.approvalLimit;
    await store.saveAction(entry);
    return [200, { cart: card }];
  })));

  app.post("/actions/:id/tracking", async (req, res) => send(res, await store.tx(async (): Promise<Reply> => {
    const entry = await store.lockedAction(req.params.id);
    if (!entry || entry.card.type !== "cart") return [404];
    if (!await isOwner(req, entry.householdId)) return [403];
    if (!entry.card.cart.lines.length) return [409, {error: "Cart has no items"}];
    const tracking = entry.tracking ??= {};
    const { state, remindAt } = req.body ?? {};
    if (remindAt !== undefined) {
      const time = typeof remindAt === "string" ? Date.parse(remindAt) : NaN;
      if (!(time > Date.now()) || state !== undefined) return [400, {error: "Choose a future reminder time"}];
      if (entry.done || tracking.remindAt) return [409, {error: "Cart already handled or reminder already set"}];
      if (!await store.alerts.hasDevice(entry.householdId)) return [409, {error: "Enable grocery notifications first"}];
      tracking.remindAt = new Date(time).toISOString();
      await store.alerts.queue(entry.householdId, entry.card.id, "reminder", time);
    } else if (state === "ordered") {
      const cart = entry.card.cart as typeof entry.card.cart & {reviewId?: string};
      if (cart.reviewId && req.body?.reviewId !== cart.reviewId) return [409, {error: "Cart changed. Review the current items first."}];
      if (tracking.state === "delivered") return [409, {error: "Already delivered"}];
      const source: unknown = req.body?.source;
      if (source !== undefined && source !== "manual" && source !== "instamart") return [400, {error: "Unknown purchase source"}];
      const claimed = await store.instamartClaimed(entry.card.id);
      const usingInstamart = source === "instamart" || (!source && !!claimed);
      const receipt = tracking.receipt ?? (usingInstamart ? await store.instamartReceipt(entry.card.id, cartRevision(cart)) : manualReceipt(cart));
      if (!receipt || (usingInstamart && (receipt.source !== "instamart" || receipt.receiptId !== req.body?.receiptId)) ||
          (source && receipt.source !== source) || (entry.done && !tracking.receipt)) {
        return [409, {error: "Review the current purchase receipt before confirming."}];
      }
      tracking.receipt = receipt;
      tracking.state = "ordered";
      delete tracking.remindAt;
      await store.confirmPurchase(entry, receipt);
      return [200, tracking];
    } else if (state === "delivered") {
      if (!tracking.state) return [409, {error: "Mark the order placed first"}];
      tracking.state = "delivered";
      tracking.deliveredAt ??= new Date().toISOString();
    } else return [400, {error: "Unknown tracking update"}];
    await store.saveAction(entry);
    return [200, tracking];
  })));

  app.post("/actions/:id/approve", async (req, res) => {
    // An immediate order comes back confirmed; placeOrder runs after the commit so its claim is committed before checkout.
    const out = await store.tx(async (): Promise<Reply | Entry> => {
      const entry = await store.lockedAction(req.params.id);
      if (!entry) return [404, { error: "unknown action" }];
      const { card } = entry;
      if (card.type === "question" || card.type === "meal-plan") return [400, { error: `${card.type} cards are answered, not approved` }];
      if (card.type === "cart" && await store.instamartClaimed(card.id)) {
        return [409, {error: "Confirm the reviewed purchase using grocery tracking."}];
      }
      // { order: "now" | ISO time } on a cart → an order card; approving that card is the explicit confirmation
      const want: unknown = req.body?.order;
      let scheduledFor: string | undefined;
      if (want !== undefined) {
        if (card.type !== "cart") return [400, { error: "only carts can be ordered" }];
        if (entry.done) return [409, { error: "cart already approved" }];
        if (want !== "now") {
          const at = typeof want === "string" ? Date.parse(want) : NaN;
          if (Number.isNaN(at)) return [400, { error: 'order must be "now" or an ISO time' }];
          scheduledFor = new Date(at).toISOString(); // UTC, so dueOrders can compare strings
        }
      }
      if (card.type === "cart" || card.type === "order") {
        const cart = reviewOf(card.type === "cart" ? card.cart : card.order.cart);
        if (!cart.lines.length) return [409, { error: "This cart is empty." }];
        if (!entry.done && !matchesHouseholdBill(cart)) return [409, { error: "Review the current quantities and prices." }];
        const requiresReview = !entry.done && (entry.refreshedBill || (card.type === "order" && cart.reviewId));
        if ((req.body?.reviewId !== undefined || requiresReview)
            && cart.reviewId !== req.body?.reviewId) {
          return [409, { error: "Cart changed. Review the current bill before confirming." }];
        }
      }
      if (card.type === "order") {
        const confirmed = await store.confirmOrder(card.id);
        if (confirmed.card.type !== "order") return [409, {error: "Order changed"}];
        return confirmed;
      }
      if (!entry.done && card.type === "cart" && want === undefined) {
        const household = (await store.lockedHousehold(entry.householdId))!;
        recordPurchase(household, manualReceipt(card.cart));
        await store.saveHousehold(household);
      }
      entry.done = true;
      await store.saveAction(entry);
      if (card.type === "cart" && want !== undefined) {
        const order: ActionCard = { id: randomUUID(), type: "order", order: { cart: card.cart, status: "scheduled", ...(scheduledFor && { scheduledFor }) }, needsApproval: true };
        await store.addAction({ card: order, householdId: entry.householdId, callId: entry.callId, done: false });
        return [200, { status: "approved", order }];
      }
      return [200, { status: "approved", ...(card.type === "advance" && card.upiUrl && { upiUrl: card.upiUrl }) }];
    });
    if (Array.isArray(out)) return send(res, out);
    if (out.card.type !== "order") throw new Error("Expected an order");
    const order = out.card.order;
    const result = order.status === "scheduled" && !order.scheduledFor ? await placeOrder(out, store, swiggy) : order;
    res.json({status: "approved", order: result});
  });

  app.post("/actions/:id/answer", async (req, res) => {
    // A spoken answer is transcribed before the transaction; the transaction then checks the question didn't change meanwhile.
    let spoken: { card: ActionCard; text: string } | undefined;
    if (Buffer.isBuffer(req.body)) {
      const before = await store.action(req.params.id);
      if (before?.card.type === "question" && before.choices && !before.done) {
        if (!req.body.length) return void res.status(400).json({ error: "empty audio body" });
        const { card } = before;
        const lang = (await store.household(before.householdId))!.cook.lang;
        spoken = { card, text: (await withAudio(req, path => stt.transcribe(path, { lang, keywords: card.options }))).text };
      }
    }
    send(res, await store.tx(async (): Promise<Reply> => {
      const entry = await store.lockedAction(req.params.id);
      if (!entry) return [404, { error: "unknown action" }];
      const { card, choices } = entry;
      if (card.type === "meal-plan") {
        if (entry.done) return [409, { error: "already answered" }];
        const option = MEAL_CHOICES.find((c) => c === req.body?.option);
        if (!option) return [400, { error: `option must be one of ${JSON.stringify(MEAL_CHOICES)}` }];
        const household = (await store.lockedHousehold(entry.householdId))!;
        const day = WEEKDAYS[new Date(`${card.plan.date}T00:00:00Z`).getUTCDay()]!; // the date is a calendar day, not an instant
        const habit = (household.habits ??= {})[day] ??= { cook: 0, order: 0 };
        habit[option]++;
        await store.saveHousehold(household);
        entry.done = true;
        entry.selectedMeal = option;
        await store.saveAction(entry);
        if (option === "order") return [200, { status: "answered" }];
        const saved = reviewOf(card.plan.cook.cart);
        const cart = saved.reviewId ? saved : priceCart(requestsFromCart(saved), household);
        const fresh: ActionCard = { id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit };
        await store.addAction({ card: fresh, householdId: household.id, done: false });
        for (const issue of cart.held ?? []) {
          const question = quantityQuestion(issue, household);
          await store.addAction({ ...question, cartId: fresh.id, householdId: household.id, done: false });
        }
        return [200, { status: "answered", cart: fresh }];
      }
      if (card.type !== "question" || !choices) return [400, { error: "only questions can be answered" }];
      if (entry.done) return [409, { error: "already answered" }];
      let option: unknown = req.body?.option;
      if (Buffer.isBuffer(req.body)) {
        if (!spoken || JSON.stringify(spoken.card) !== JSON.stringify(card)) return [409, { error: "This question has changed." }];
        option = spokenOption(card, choices, spoken.text);
        if (!option) return [422, { error: "Please tap one of the choices." }];
      }
      if (typeof option !== "string" || !card.options.includes(option)) {
        return [400, { error: `option must be one of ${JSON.stringify(card.options)}` }];
      }
      const line = choices[card.options.indexOf(option)];
      const { callId, householdId } = entry;
      const relatedId = entry.cartId ?? (callId && (await store.call(callId))?.entries.find(e => e.card.type === "cart" && !e.done)?.card.id);
      const related = relatedId ? await store.lockedAction(relatedId) : undefined;
      const cartEntry = related && !related.done ? related : undefined;
      const previous = cartEntry?.card.type === "cart" ? reviewOf(cartEntry.card.cart) : undefined;
      const held = (previous?.held ?? []).filter(h => h.index !== entry.heldIndex);
      if (!line) {
        if (previous && cartEntry && held.length !== previous.held?.length) {
          previous.held = held;
          previous.reviewId = randomUUID();
          await store.saveAction(cartEntry);
        }
        entry.done = true;
        await store.saveAction(entry);
        return [200, { status: "answered" }];
      }
      const lines = [...(previous ? requestsFromCart(previous) : []), { ...line, confidence: 1 }];
      const household = (await store.household(householdId))!;
      if (entry.word) await store.voteWord(household, entry.word, line.item);
      const next = groceryPlan({ groceries: lines, notes: [] }, household);
      if (next.questions.length) {
        const followUp = next.questions[0]!;
        entry.card = { ...followUp.card, id: card.id };
        entry.choices = followUp.choices;
        await store.saveAction(entry);
        return [422, { error: followUp.card.text, question: entry.card }];
      }
      next.cart.held = held;
      const fresh: ActionCard = { id: cartEntry?.card.id ?? randomUUID(), type: "cart", cart: next.cart, needsApproval: next.cart.total > household.approvalLimit };
      entry.done = true;
      await store.saveAction(entry);
      if (cartEntry) {
        cartEntry.card = fresh;
        await store.saveAction(cartEntry);
      } else {
        await store.addAction({ card: fresh, callId, householdId, done: false }, { first: true });
      }
      return [200, { status: "answered", ...(access?.role(req) !== "cook" && { cart: cartEntry?.card ?? fresh }) }];
    }));
  });

  app.post("/households", async (req, res) => {
    const user = access?.user(req);
    const parsed = parseSignup(req.body, user && (user.phone_number ?? ""));
    if (typeof parsed === "string") return void res.status(400).json({ error: parsed });
    const id = randomUUID();
    const household: Household = { id, ...parsed, pantry: {}, platform: "mock", history: [] };
    if (user) {
      const profile = householdProfile(req.body);
      if (!profile) return void res.status(400).json({ error: "Enter a household name and location." });
      await store.tx(async () => {
        await store.addHousehold(household, id);
        await store.auth.addOwner(id, user.uid, profile);
      });
      return void res.status(201).json({ id });
    }
    const ownerToken = randomBytes(32).toString("base64url");
    let cookCode: string;
    do cookCode = Array.from({ length: 6 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
    while (!await store.addHousehold(household, cookCode, ownerToken));
    res.set("cache-control", "no-store").status(201).json({ id, cookCode, ownerToken, instamartAvailable: !!instamart });
  });

  if (access) app.post("/auth/claim", async (req, res) => {
    const { uid, phone_number: phone } = access.user(req);
    if (!phone) return void res.status(403).json({ error: "Link a verified phone in Sign-in methods before recovering a household." });
    const { householdId, ownerToken } = req.body ?? {};
    const profile = householdProfile(req.body);
    if (typeof householdId !== "string" || typeof ownerToken !== "string" || !profile) {
      return void res.status(400).json({ error: "Enter a household name and location." });
    }
    const claimed = await store.tx(async () => {
      const household = await store.lockedHousehold(householdId);
      if (!household?.owner) return false;
      if (await store.auth.role(householdId, uid) === "owner") return true;
      if (!await store.isOwner(householdId, "Bearer " + ownerToken)) return false;
      await store.auth.addOwner(householdId, uid, profile);
      household.owner.phone = phone;
      await store.saveHousehold(household);
      await store.revokeOwnerKey(householdId);
      return true;
    });
    if (!claimed) return void res.status(404).json({ error: "The saved owner credential could not recover this household." });
    res.status(200).json({ id: householdId });
  });

  app.post("/households/:id/alerts", async (req, res) => {
    if (!await isOwner(req, req.params.id)) return void res.sendStatus(403);
    const token = req.body?.token;
    if (typeof token !== "string" || !/^Expo(?:nent)?PushToken\[[a-zA-Z0-9_-]{1,200}\]$/.test(token)) {
      return void res.status(400).json({error: "Invalid Expo device token"});
    }
    await store.alerts.register(req.params.id, token);
    res.sendStatus(204);
  });

  app.post("/join", async (req, res) => {
    const household = await store.householdByCode(String(req.body?.code ?? "").trim().toUpperCase());
    if (!household) return void res.status(404).json({ error: "unknown code" });
    res.json({ householdId: household.id, role: "cook", cook: { name: household.cook.name, lang: household.cook.lang } });
  });

  app.post("/households/:id/meal-plan", async (req, res) => {
    const household = await store.household(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    const DAY = 86_400_000, IST = 5.5 * 3_600_000;
    const date: unknown = req.body?.date ?? new Date(Date.now() + IST + DAY).toISOString().slice(0, 10);
    if (typeof date !== "string" || !/^\d{4}-\d\d-\d\d$/.test(date) || Number.isNaN(Date.parse(date))) {
      return void res.status(400).json({ error: "date must be YYYY-MM-DD" });
    }
    const card: ActionCard = { id: randomUUID(), type: "meal-plan", plan: await planMeals(household, date, { llm }), options: [...MEAL_CHOICES] };
    await store.addAction({ card, householdId: household.id, done: false });
    res.status(201).json(card);
  });

  app.get("/households/:id", async (req, res) => {
    const household = await store.household(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    res.json(household);
  });

  // ponytail: unauthenticated, like the rest of the demo API; anyone with the URL can reset h1.
  app.post("/households/:id/reset", async (req, res) => {
    if (req.params.id !== householdJson.id) return void res.status(404).json({ error: "only the demo household can be reset" });
    await store.resetDemo();
    res.json({ status: "reset" });
  });

  if (!auth) app.use(express.static(webDir));

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
