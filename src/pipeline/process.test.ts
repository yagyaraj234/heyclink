import { test } from "node:test";
import assert from "node:assert/strict";
import type { Household, Lang, Llm, Stt } from "../contracts.ts";
import household from "../../fixtures/household.json" with { type: "json" };
import case01 from "../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import case02 from "../../fixtures/cases/cook-hinglish-02.json" with { type: "json" };
import cooking01 from "../../fixtures/cases/indicvoices-hi-cooking-01.json" with { type: "json" };
import { processCall } from "./process.ts";
import { sarvamStt } from "./adapters/sarvam-stt.ts";
import { openaiStt } from "./adapters/openai-stt.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      { raw: "ek packet Amul doodh", itemWord: "doodh", qtyPhrase: "ek packet", item: "milk", qty: 1, unit: "packet", brand: "Amul", confidence: 1 },
    ],
    advance: { amount: 500, reason: null },
    notes: ["kal 8 baje aaungi"],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction, case01.gold);
  assert.equal(res.transcript.text, case01.transcript);
  assert.deepEqual(res.actions.map((a) => a.type), ["cart", "advance"]);
  assert.ok(res.callId);
  // STT is biased toward this household's brands
  assert.ok(sttCalls[0]!.keywords.includes("aashirvaad"));
  // LLM sees household brands (for "wahi wala") and a schema
  assert.match(llmCalls[0]!.user, /aashirvaad/);
  const t = res.timings;
  for (const k of ["sttMs", "extractMs", "planMs", "totalMs"] as const) assert.ok(t[k] >= 0, k);
  assert.ok(t.totalMs >= t.sttMs + t.extractMs);
});

test("processCall: out-of-catalog item (pizza base) is dropped, not forced onto an id", async () => {
  const { stt } = fakeStt("मैं एक पैकेट इंग्लिश ओवन बेस पिज़्ज़ा ख़रीदना चाहता हूँ", "hi");
  const { llm, calls } = fakeLlm({
    groceries: [
      { raw: "एक पैकेट इंग्लिश ओवन बेस पिज़्ज़ा", itemWord: "पिज़्ज़ा बेस", qtyPhrase: "एक पैकेट", item: null, qty: 1, unit: "packet", brand: "english-oven", confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction, { groceries: [], notes: [] });
  // the schema must let the model say "not in catalog"
  assert.match(JSON.stringify(calls[0]!.schema), /"enum":\[[^\]]*null/);
});

test("processCall with harness off (eval baseline): no household context reaches the LLM", async () => {
  const { stt, calls: sttCalls } = fakeStt(case02.transcript, case02.lang);
  const { llm, calls } = fakeLlm({ groceries: [], advance: null, notes: [] });

  await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm }, { harness: false });

  assert.doesNotMatch(calls[0]!.user, /aashirvaad|india-gate|diabetic/);
  assert.deepEqual(sttCalls[0]!.keywords, []);
  assert.doesNotMatch(calls[0]!.system, /dedh|gaddi/); // qty rules are harness too
});

test("processCall: unsure lines become question cards in the order they were heard", async () => {
  const { stt } = fakeStt("atta do kilo, thoda methi, aur woh tel", "hi");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "atta do kilo", itemWord: "atta", qtyPhrase: "do kilo", item: "atta", qty: 2, unit: "kg", brand: null, confidence: 0.95 },
      { raw: "thoda methi", itemWord: "methi", qtyPhrase: "thoda", item: "methi", qty: 1, unit: "bunch", brand: null, confidence: 0.4 },
      { raw: "woh tel", itemWord: "tel", qtyPhrase: "", item: "mustard-oil", qty: 1, unit: "l", brand: null, confidence: 0.3 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.actions.map((a) => a.type), ["cart", "question", "question"]);
  const questions = res.actions.flatMap((a) => (a.type === "question" ? [a.text] : []));
  assert.match(questions[0]!, /thoda methi/);
  assert.match(questions[1]!, /woh tel/);
  const cart = res.actions[0]!;
  assert.ok(cart.type === "cart" && cart.cart.lines.length === 1 && cart.cart.lines[0]!.item === "atta");
});

test("processCall: indic harness fixes LLM slips (dedh → 1.5, hari mirch → green-chilli) to match gold", async () => {
  const { stt, calls: sttCalls } = fakeStt(case02.transcript, case02.lang);
  const { llm } = fakeLlm({
    groceries: [
      { raw: "dedh kilo pyaaz", itemWord: "pyaaz", qtyPhrase: "dedh kilo", item: "onion", qty: 1, unit: "kg", brand: null, confidence: 1 },
      { raw: "paav kilo hari mirch", itemWord: "hari mirch", qtyPhrase: "paav kilo", item: "capsicum", qty: 250, unit: "g", brand: null, confidence: 1 },
      { raw: "aadha litre dahi", itemWord: "dahi", qtyPhrase: "aadha litre", item: "curd", qty: 0.5, unit: "l", brand: null, confidence: 1 },
    ],
    advance: null,
    notes: ["chawal bhi khatam hone wala hai"],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction, case02.gold);
  // STT is also biased toward common spoken item words, not just this household's
  assert.ok(sttCalls[0]!.keywords.includes("hari mirch"));
});

test("processCall with real STT adapters: browser webm uploads are sent as audio/webm", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "vfi-"));
  const audioPath = join(dir, "note.webm");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(audioPath, "not really audio");
  const saved = { ...process.env };
  t.after(() => void (process.env = saved));
  process.env.OPENAI_API_KEY = "test";
  process.env.SARVAM_API_KEY = "test";
  const uploads: { url: string; type: string; name: string }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const file = (init.body as FormData).get("file") as File;
    uploads.push({ url, type: file.type, name: file.name });
    const body = url.includes("sarvam") ? { transcript: "do kilo pyaaz", language_code: "hi-IN" } : { text: "do kilo pyaaz", languages: [{ code: "hi" }] };
    return Response.json(body);
  });
  const { llm } = fakeLlm({ groceries: [], advance: null, notes: [] });

  for (const stt of [sarvamStt(), openaiStt()]) await processCall({ audioPath, householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(uploads.map((u) => [u.type, u.name]), [["audio/webm", "note.webm"], ["audio/webm", "note.webm"]]);
});

test("processCall: brand spoken as the item (Tata Tea, Surf Excel, Vim bar, Amul doodh) → generic item + brand id", async () => {
  const { stt } = fakeStt("Didi, aadha kilo Tata Tea, ek packet Surf Excel, do Vim bar, aur do packet Amul doodh.", "hi");
  // slips seen as "dropped or wrong": brand read as an out-of-catalog item, brand missing, brand slug keeps the product word
  const { llm } = fakeLlm({
    groceries: [
      { raw: "aadha kilo Tata Tea", itemWord: "Tata Tea", qtyPhrase: "aadha kilo", item: null, qty: 0.5, unit: "kg", brand: "Tata Tea", confidence: 0.9 },
      { raw: "ek packet Surf Excel", itemWord: "Surf Excel", qtyPhrase: "ek packet", item: "detergent-powder", qty: 1, unit: "packet", brand: null, confidence: 0.9 },
      { raw: "do Vim bar", itemWord: "Vim bar", qtyPhrase: "do", item: "dishwash-bar", qty: 2, unit: "piece", brand: "vim-bar", confidence: 0.9 },
      { raw: "do packet Amul doodh", itemWord: "Amul doodh", qtyPhrase: "do packet", item: null, qty: 2, unit: "packet", brand: null, confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(
    res.extraction.groceries.map((g) => [g.item, g.brand]),
    [["tea", "tata"], ["detergent-powder", "surf-excel"], ["dishwash-bar", "vim"], ["milk", "amul"]],
  );
});

test("processCall: no brand said → cart uses the household's preferred brand, extraction stays brandless", async () => {
  const { stt } = fakeStt("do litre doodh aur ek kilo dahi", "hi");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "do litre doodh", itemWord: "doodh", qtyPhrase: "do litre", item: "milk", qty: 2, unit: "l", brand: null, confidence: 1 },
      { raw: "ek kilo dahi", itemWord: "dahi", qtyPhrase: "ek kilo", item: "curd", qty: 1, unit: "kg", brand: null, confidence: 1 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => g.brand), [undefined, undefined]);
  const cart = res.actions[0]!;
  assert.ok(cart.type === "cart");
  assert.deepEqual(cart.cart.lines.map((l) => [l.item, l.brand]), [["milk", "amul"], ["curd", undefined]]);
});

test("processCall: kishmish / kismis / किशमिश all land on raisins, and the LLM is told so", async () => {
  const { stt } = fakeStt("sau gram kishmish, sau gram kismis, sau gram किशमिश", "hi");
  // run-to-run drift: the model sometimes picks grapes or gives up on the dried fruit
  const { llm, calls } = fakeLlm({
    groceries: [
      { raw: "sau gram kishmish", itemWord: "kishmish", qtyPhrase: "sau gram", item: "grapes", qty: 100, unit: "g", brand: null, confidence: 0.9 },
      { raw: "sau gram kismis", itemWord: "kismis", qtyPhrase: "sau gram", item: null, qty: 100, unit: "g", brand: null, confidence: 0.9 },
      { raw: "sau gram किशमिश", itemWord: "किशमिश", qtyPhrase: "sau gram", item: "grapes", qty: 100, unit: "g", brand: null, confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => g.item), ["raisins", "raisins", "raisins"]);
  const told = calls[0]!.system + JSON.stringify(calls[0]!.schema);
  for (const spoken of ["kishmish", "kismis", "किशमिश", "किसमिस"]) assert.ok(told.includes(spoken), spoken);
  assert.match(told, /raisins/);
});

test("processCall: brand word in front of the item overrides a wrong LLM item (Amul doodh ≠ butter, Tata Tea ≠ salt)", async () => {
  const { stt } = fakeStt("ek packet Amul doodh aur aadha kilo Tata Tea", "hi");
  const { llm, calls } = fakeLlm({
    groceries: [
      { raw: "ek packet Amul doodh", itemWord: "Amul doodh", qtyPhrase: "ek packet", item: "butter", qty: 1, unit: "packet", brand: "amul", confidence: 0.9 },
      { raw: "aadha kilo Tata Tea", itemWord: "Tata Tea", qtyPhrase: "aadha kilo", item: "salt", qty: 0.5, unit: "kg", brand: "tata", confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.brand]), [["milk", "amul"], ["tea", "tata"]]);
  assert.match(calls[0]!.system, /Tata Tea→tea/);
});

test("processCall: an ingredient named while narrating a recipe is not bought (cooking-01: नींबू)", async () => {
  const { stt } = fakeStt(cooking01.transcript, cooking01.lang);
  // live reply shape (2026-11-21): lemon came back at 0.72 and went into the cart
  const { llm, calls } = fakeLlm({
    groceries: [
      { raw: "एक किलो दूध", requested: true, itemWord: "दूध", qtyPhrase: "एक किलो", item: "milk", qty: 1, unit: "kg", brand: null, confidence: 1 },
      { raw: "नींबू", requested: false, itemWord: "नींबू", qtyPhrase: "", item: "lemon", qty: 1, unit: "piece", brand: null, confidence: 0.72 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction, cooking01.gold);
  // strict structured outputs: the model must always answer whether the line was asked for
  assert.match(JSON.stringify(calls[0]!.schema), /"required":\["raw","requested"/);
  // a price/availability question is still shopping (te-bigbasket-01 "... kismis dhara entha"), only narration is dropped
  assert.match(JSON.stringify(calls[0]!.schema), /false only[^"]*cooking[^"]*price/i);
});

test("processCall: vague 'thoda sa palak' with qty 0 becomes a one-bunch question, never a 0 g ₹0 line", async () => {
  const { stt } = fakeStt("Didi thoda sa palak le aana aur do kilo aloo", "hi");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "thoda sa palak", requested: true, itemWord: "palak", qtyPhrase: "thoda sa", item: "spinach", qty: 0, unit: "g", brand: null, confidence: 0.7 },
      { raw: "do kilo aloo", requested: true, itemWord: "aloo", qtyPhrase: "do kilo", item: "potato", qty: 2, unit: "kg", brand: null, confidence: 1 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  const palak = res.extraction.groceries[0]!;
  assert.deepEqual([palak.item, palak.qty, palak.unit], ["spinach", 1, "bunch"]);
  const cart = res.actions[0]!;
  assert.ok(cart.type === "cart");
  assert.deepEqual(cart.cart.lines.map((l) => l.item), ["potato"]);
  const question = res.actions.find((a) => a.type === "question");
  assert.ok(question?.type === "question");
  assert.match(question.text, /1 bunch Palak/);
  assert.doesNotMatch(question.text, /\b0 /);
});

test("processCall: Sarvam's 30 s limit falls back to the other STT and records the provider used", async () => {
  const tooLong = new Error(
    'sarvam stt 400: {"error":{"message":"Audio duration exceeds the maximum limit of 30 seconds. Please use the batch API for longer audio files.","code":"invalid_request_error"}}',
  );
  const sarvam: Stt = { transcribe: async () => { throw tooLong; } };
  const heard: string[][] = [];
  const openai: Stt = {
    async transcribe(_audioPath, opts) {
      heard.push(opts.keywords);
      return { text: "do kilo pyaaz", lang: "hi", provider: "openai" };
    },
  };
  const { llm } = fakeLlm({
    groceries: [{ raw: "do kilo pyaaz", requested: true, itemWord: "pyaaz", qtyPhrase: "do kilo", item: "onion", qty: 2, unit: "kg", brand: null, confidence: 1 }],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "long.webm", householdId: "h1" }, h, { stt: sarvam, fallbackStt: openai, llm });

  assert.equal(res.transcript.provider, "openai");
  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit]), [["onion", 2, "kg"]]);
  assert.ok(heard[0]!.includes("aashirvaad")); // fallback is biased with the same household keywords
  // any other STT failure still surfaces
  const broken: Stt = { transcribe: async () => { throw new Error("sarvam stt 401: bad key"); } };
  await assert.rejects(processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt: broken, fallbackStt: openai, llm }), /401/);
});
