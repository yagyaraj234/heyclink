import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGS } from "./contracts.ts";
import type { ActionCard, CallInput, CallResult, GroceryLine, Household, Lang, Llm, Stt } from "./contracts.ts";
import { cartCard, isUnsure } from "./actions/plan.ts";
import householdJson from "../fixtures/household.json" with { type: "json" };

/** Lane 1's processCall (src/pipeline/process.ts) satisfies this; tests inject it with fake ports. */
export type ProcessCall = (input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }) => Promise<CallResult>;

export interface AppDeps {
  processCall: ProcessCall;
  stt: Stt;
  llm: Llm;
  corsOrigin?: string; // default "*": the API has no cookies or auth
  webDir?: string; // built web UI, served after the API routes; a missing dir just 404s
  health?: { stt: string; llm: string }; // names only, never keys; GET /health reports them
}

// STT providers sniff format from the file extension. The header is client input: anything but a plain token → "bin".
const EXT: Record<string, string> = { mpeg: "mp3", mp4: "m4a", wave: "wav", "vnd.wave": "wav" };
const extFor = (contentType = "") => {
  const sub = contentType.split(";")[0]!.split("/")[1]?.trim().toLowerCase().replace(/^x-/, "") ?? "";
  const ext = EXT[sub] ?? sub;
  return /^[a-z0-9]+$/.test(ext) ? ext : "bin";
};

export function createApp({ processCall, stt, llm, corsOrigin = "*", webDir = join(import.meta.dirname, "../web/dist"), health = { stt: "unknown", llm: "unknown" } }: AppDeps) {
  // ponytail: in-memory state, lost on restart; swap for sqlite if the demo needs persistence.
  const households = new Map<string, Household>([[householdJson.id, structuredClone(householdJson) as Household]]);
  const calls = new Map<string, CallResult>();
  const callHousehold = new Map<string, string>(); // callId → householdId; CallResult doesn't carry it
  // done = approved (cart/advance) or answered (question). lines = what the cart is built from; line = the question's line.
  type Entry = { card: ActionCard; callId: string; householdId: string; done: boolean; lines?: GroceryLine[]; line?: GroceryLine };
  const actions = new Map<string, Entry>();
  // CallResult (frozen) has no done flag, so responses add one status per action id.
  const withStatus = (call: CallResult) => ({
    ...call,
    status: Object.fromEntries(call.actions.map((a) => [a.id, !actions.get(a.id)?.done ? "pending" : a.type === "question" ? "answered" : "approved"])),
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
    const household = households.get(householdId);
    if (!household) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    const lang: Lang | undefined = LANGS.find((l) => l === (req.query.lang ?? body.lang));

    let result: CallResult;
    if (isAudio) {
      if (!req.body.length) return void res.status(400).json({ error: "empty audio body" });
      const audioPath = join(tmpdir(), `vfi-${randomUUID()}.${extFor(req.get("content-type"))}`);
      await writeFile(audioPath, req.body);
      try {
        result = await processCall({ audioPath, householdId, lang }, household, { stt, llm });
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
      result = await processCall({ audioPath: "", householdId, lang }, household, { stt: textStt, llm });
    }

    calls.set(result.callId, result);
    callHousehold.set(result.callId, householdId);
    const { callId, extraction } = result;
    const unsure = extraction.groceries.filter(isUnsure); // question cards follow unsure-line order (planActions)
    let q = 0;
    for (const card of result.actions) {
      const entry: Entry = { card, callId, householdId, done: false };
      if (card.type === "cart") entry.lines = extraction.groceries.filter((l) => !isUnsure(l));
      if (card.type === "question") entry.line = unsure[q++];
      actions.set(card.id, entry);
    }
    res.status(201).json(withStatus(result));
  });

  app.get("/calls", (req, res) => {
    const householdId = String(req.query.householdId ?? "");
    if (!households.has(householdId)) return void res.status(404).json({ error: `unknown household "${householdId}"` });
    // ponytail: O(all calls) scan; fine for an in-memory demo.
    res.json([...calls.values()].filter((c) => callHousehold.get(c.callId) === householdId).reverse().map(withStatus));
  });

  app.get("/calls/:id", (req, res) => {
    const call = calls.get(req.params.id);
    if (!call) return void res.status(404).json({ error: "unknown call" });
    res.json(withStatus(call));
  });

  app.post("/actions/:id/approve", (req, res) => {
    const entry = actions.get(req.params.id);
    if (!entry) return void res.status(404).json({ error: "unknown action" });
    const { card } = entry;
    if (card.type === "question") return void res.status(400).json({ error: "questions are answered, not approved" });
    if (!entry.done && card.type === "cart") {
      households.get(entry.householdId)?.history.push({
        at: new Date().toISOString().slice(0, 10),
        lines: card.cart.lines.map(({ item, qty, unit, brand }) => ({ item, qty, unit, ...(brand && { brand }) })),
      });
    }
    entry.done = true;
    res.json({ status: "approved", ...(card.type === "advance" && card.upiUrl && { upiUrl: card.upiUrl }) });
  });

  app.post("/actions/:id/answer", async (req, res) => {
    const entry = actions.get(req.params.id);
    if (!entry) return void res.status(404).json({ error: "unknown action" });
    const { card, line } = entry;
    if (card.type !== "question" || !line) return void res.status(400).json({ error: "only questions can be answered" });
    if (entry.done) return void res.status(409).json({ error: "already answered" });
    const option: unknown = req.body?.option;
    if (typeof option !== "string" || !card.options.includes(option)) {
      return void res.status(400).json({ error: `option must be one of ${JSON.stringify(card.options)}` });
    }
    if (option !== card.options[0]) {
      entry.done = true;
      return void res.json({ status: "answered" });
    }

    const call = calls.get(entry.callId)!;
    const cartEntry = call.actions.map((a) => actions.get(a.id)!).find((e) => e.card.type === "cart");
    if (cartEntry?.done) return void res.status(409).json({ error: "cart already approved" });
    const lines = [...(cartEntry?.lines ?? []), line];
    const fresh = await cartCard(lines, households.get(entry.householdId)!);
    entry.done = true;
    if (cartEntry) {
      Object.assign(cartEntry.card, { cart: fresh.cart, needsApproval: fresh.needsApproval });
      cartEntry.lines = lines;
    } else {
      call.actions.unshift(fresh);
      actions.set(fresh.id, { card: fresh, callId: entry.callId, householdId: entry.householdId, done: false, lines });
    }
    res.json({ status: "answered", cart: cartEntry?.card ?? fresh });
  });

  app.get("/households/:id", (req, res) => {
    const household = households.get(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    res.json(household);
  });

  // ponytail: unauthenticated, like the rest of the demo API; anyone with the URL can reset h1.
  app.post("/households/:id/reset", (req, res) => {
    const id = req.params.id;
    if (!households.has(id)) return void res.status(404).json({ error: "unknown household" });
    households.set(id, structuredClone(householdJson) as Household); // only h1 exists, and it comes from the fixture
    for (const [callId, hid] of callHousehold) {
      if (hid !== id) continue;
      calls.delete(callId);
      callHousehold.delete(callId);
    }
    for (const [actionId, e] of actions) if (e.householdId === id) actions.delete(actionId);
    res.json({ status: "reset" });
  });

  app.use(express.static(webDir));

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
