import { test } from "node:test";
import assert from "node:assert/strict";
import type { Household, Lang, Llm, Stt } from "../contracts.ts";
import household from "../../fixtures/household.json" with { type: "json" };
import case01 from "../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import case02 from "../../fixtures/cases/cook-hinglish-02.json" with { type: "json" };
import { processCall } from "./process.ts";

const h = household as Household;

function fakeStt(text: string, lang: string) {
  const calls: { audioPath: string; keywords: string[] }[] = [];
  const stt: Stt = {
    async transcribe(audioPath, opts) {
      calls.push({ audioPath, keywords: opts.keywords });
      return { text, lang: lang as Lang, provider: "fake" };
    },
  };
  return { stt, calls };
}

function fakeLlm(reply: unknown) {
  const calls: { system: string; user: string; schema: object }[] = [];
  const llm: Llm = {
    async json<T>(args: { system: string; user: string; schema: object; schemaName: string }) {
      calls.push(args);
      return reply as T;
    },
  };
  return { llm, calls };
}

test("processCall: cook note → gold extraction, household context to both ports, timings", async () => {
  const { stt, calls: sttCalls } = fakeStt(case01.transcript, case01.lang);
  const { llm, calls: llmCalls } = fakeLlm({
    groceries: [
      { raw: "atta ... wahi wala do kilo", itemWord: "atta", qtyPhrase: "do kilo", item: "atta", qty: 2, unit: "kg", brand: "aashirvaad", confidence: 1 },
      { raw: "do gaddi dhaniya", itemWord: "dhaniya", qtyPhrase: "do gaddi", item: "coriander", qty: 2, unit: "bunch", brand: null, confidence: 1 },
      { raw: "ek packet Amul doodh", itemWord: "doodh", qtyPhrase: "ek packet", item: "milk", qty: 1, unit: "packet", brand: "amul", confidence: 1 },
    ],
    advance: { amount: 500, reason: null },
    notes: ["kal 8 baje aaungi"],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction, case01.gold);
  assert.equal(res.transcript.text, case01.transcript);
  assert.deepEqual(res.actions, []);
  assert.ok(res.callId);
  // STT is biased toward this household's brands
  assert.ok(sttCalls[0]!.keywords.includes("aashirvaad"));
  // LLM sees household brands (for "wahi wala") and a schema
  assert.match(llmCalls[0]!.user, /aashirvaad/);
  const t = res.timings;
  for (const k of ["sttMs", "extractMs", "planMs", "totalMs"] as const) assert.ok(t[k] >= 0, k);
  assert.ok(t.totalMs >= t.sttMs + t.extractMs);
});
