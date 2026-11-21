import express from "express";
import type { NextFunction, Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LANGS } from "./contracts.ts";
import type { ActionCard, CallResult, Household, Lang, Llm, Stt } from "./contracts.ts";
import type { ProcessCall } from "./actions/pipeline-stub.ts";
import householdJson from "../fixtures/household.json" with { type: "json" };

export interface AppDeps {
  processCall: ProcessCall;
  stt: Stt;
  llm: Llm;
}

// STT providers sniff format from the file extension.
const extFor = (contentType = "") => {
  const sub = contentType.split(";")[0]!.split("/")[1]?.trim().replace(/^x-/, "") ?? "bin";
  return ({ mpeg: "mp3", mp4: "m4a" } as Record<string, string>)[sub] ?? sub;
};

export function createApp({ processCall, stt, llm }: AppDeps) {
  // ponytail: in-memory state, lost on restart; swap for sqlite if the demo needs persistence.
  const households = new Map<string, Household>([[householdJson.id, structuredClone(householdJson) as Household]]);
  const calls = new Map<string, CallResult>();
  const actions = new Map<string, { card: ActionCard; householdId: string; approved: boolean }>();

  const app = express();
  app.use(express.json());
  app.use(express.raw({ type: "audio/*", limit: "25mb" }));

  app.post("/calls", async (req, res) => {
    const isAudio = Buffer.isBuffer(req.body);
    const body = isAudio ? {} : (req.body ?? {});
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
    for (const card of result.actions) actions.set(card.id, { card, householdId, approved: false });
    res.status(201).json(result);
  });

  app.get("/calls/:id", (req, res) => {
    const call = calls.get(req.params.id);
    if (!call) return void res.status(404).json({ error: "unknown call" });
    res.json(call);
  });

  app.post("/actions/:id/approve", (req, res) => {
    const entry = actions.get(req.params.id);
    if (!entry) return void res.status(404).json({ error: "unknown action" });
    const { card } = entry;
    if (card.type === "question") return void res.status(400).json({ error: "questions are answered, not approved" });
    if (!entry.approved && card.type === "cart") {
      households.get(entry.householdId)?.history.push({
        at: new Date().toISOString().slice(0, 10),
        lines: card.cart.lines.map(({ item, qty, unit, brand }) => ({ item, qty, unit, ...(brand && { brand }) })),
      });
    }
    entry.approved = true;
    res.json({ status: "approved", ...(card.type === "advance" && card.upiUrl && { upiUrl: card.upiUrl }) });
  });

  app.get("/households/:id", (req, res) => {
    const household = households.get(req.params.id);
    if (!household) return void res.status(404).json({ error: "unknown household" });
    res.json(household);
  });

  app.use((err: Error & { status?: number }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status ?? 500).json({ error: err.message });
  });

  return app;
}
