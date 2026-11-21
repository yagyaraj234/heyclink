import { test } from "node:test";
import assert from "node:assert/strict";
import type { Household, Lang, Llm, Stt } from "../contracts.ts";
import household from "../../fixtures/household.json" with { type: "json" };
import case01 from "../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import case02 from "../../fixtures/cases/cook-hinglish-02.json" with { type: "json" };
import cooking01 from "../../fixtures/cases/indicvoices-hi-cooking-01.json" with { type: "json" };
import teBigbasket01 from "../../fixtures/cases/indicvoices-te-bigbasket-01.json" with { type: "json" };
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

test("processCall: harness keeps a spoken brand the LLM dropped or misspelled (हैंको / hanko → henko)", async () => {
  const { stt } = fakeStt("मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें। aur ek hanko bar", "hi");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "0.25 किलो हैंको डिटर्जेंट बार", requested: true, itemWord: "हैंको डिटर्जेंट बार", qtyPhrase: "0.25 किलो", item: "detergent-powder", qty: 0.25, unit: "kg", brand: null, confidence: 0.9 },
      { raw: "ek hanko bar", requested: true, itemWord: "detergent bar", qtyPhrase: "ek", item: "detergent-powder", qty: 1, unit: "piece", brand: "hanko", confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.brand]), [["detergent-powder", "henko"], ["detergent-powder", "henko"]]);
});

test("processCall: an unknown product whose name contains a catalog word is not forced onto it (chizzpa chips ≠ cheese)", async () => {
  const { stt } = fakeStt("मैं पाँच कार्टन चीज़ जपा पोटैटो क्रिप्स चिप्स ... जोड़ना चाहता हूँ", "hi");
  const { llm, calls } = fakeLlm({
    groceries: [
      { raw: "पाँच कार्टन चीज़ जपा पोटैटो क्रिप्स चिप्स", requested: true, itemWord: "चीज़ जपा पोटैटो क्रिप्स चिप्स", qtyPhrase: "पाँच कार्टन", item: null, qty: 5, unit: "packet", brand: "chizzpa", confidence: 0.8 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries, []);
  // live (eval hi-08eeb3eb) the model split off "चीज़" as its own cheese line; the schema must say not to
  const item = JSON.stringify(calls[0]!.schema);
  assert.match(item, /contains a catalog word/);
  assert.match(item, /never split one product/);
});

test("processCall: harness resolves brands through the indic brand table (बीबी రాయల్ dropped, slurp-firm misspelled)", async () => {
  const { stt } = fakeStt(`${teBigbasket01.transcript} aur ek packet slurp firm ragi atta`, "te");
  const { llm } = fakeLlm({
    groceries: [
      { raw: teBigbasket01.gold.groceries[0]!.raw, requested: true, itemWord: "బీబీ రాయల్ కిస్‍మిస్ పళ్ళు", qtyPhrase: "సున్నాపాయింట్ ఐదు కిలో", item: "raisins", qty: 0.5, unit: "kg", brand: null, confidence: 0.9 },
      { raw: "ek packet slurp firm ragi atta", requested: true, itemWord: "ragi atta", qtyPhrase: "ek packet", item: "ragi-flour", qty: 1, unit: "packet", brand: "slurp-firm", confidence: 0.9 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  const gold = teBigbasket01.gold.groceries[0]!;
  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit, g.brand]), [
    [gold.item, gold.qty, gold.unit, gold.brand],
    ["ragi-flour", 1, "packet", "slurrp-farm"],
  ]);
});

test("processCall: a brand in the spoken words beats the LLM's own spelling of it (हैंको over 'hanco')", async () => {
  const { stt } = fakeStt("मेरी आइटम सूची में 0.25 किलो हैंको डिटर्जेंट बार जोड़ें।", "hi");
  const { llm } = fakeLlm({
    groceries: [
      // live reply, eval clip hi-c5ad6286
      { raw: "0.25 किलो हैंको डिटर्जेंट बार", requested: true, itemWord: "हैंको डिटर्जेंट बार", qtyPhrase: "0.25 किलो", item: "detergent-powder", qty: 0.25, unit: "kg", brand: "hanco", confidence: 0.52 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.brand]), [["detergent-powder", "henko"]]);
});

test("processCall: harness rejoins an item word STT split in two (కర్వే పాకు → curry-leaves), even when itemWord is cut short", async () => {
  // eval te-06f702d8 (openai STT); both lines are live replies: item null, once with itemWord cut to "పాకు"
  const { stt } = fakeStt("రేపటికి డెలివరీ అవ్వవలసిన ఆర్డర్ బల్లి చేసి, అందులో ... కి బదులు ఐదు వందల గ్రాముల ఫ్రెషో కర్వే పాకు యాడ్ చేయి.", "te");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "ఐదు వందల గ్రాముల ఫ్రెషో కర్వే పాకు", requested: true, itemWord: "ఫ్రెషో కర్వే పాకు", qtyPhrase: "ఐదు వందల గ్రాముల", item: null, qty: 500, unit: "g", brand: "fresho", confidence: 0.5 },
      { raw: "ఐదు వందల గ్రాముల ఫ్రెషో కర్వే పాకు", requested: true, itemWord: "పాకు", qtyPhrase: "ఐదు వందల గ్రాముల", item: null, qty: 500, unit: "g", brand: "fresho", confidence: 0.35 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1", lang: "te" }, h, { stt, llm });

  const want = ["curry-leaves", 500, "g", "fresho"];
  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit, g.brand]), [want, want]);
});

test("processCall: harness keeps the LLM's sub-brand slug instead of cutting it to a brand word inside it (tata-sampann ≠ tata)", async () => {
  // live reply, eval hi-a0db9e12: the brand is only in raw, not in itemWord
  const { stt } = fakeStt("मेरी शॉपिंग आइटम सूची में पाँच पाउच टाटा सम्पन्न मूंग दाल जोड़ें।", "hi");
  const { llm } = fakeLlm({
    groceries: [
      { raw: "पाँच पाउच टाटा सम्पन्न मूंग दाल", requested: true, itemWord: "मूंग दाल", qtyPhrase: "पाँच पाउच", item: "moong-dal", qty: 5, unit: "packet", brand: "tata-sampann", confidence: 0.99 },
    ],
    advance: null,
    notes: [],
  });

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.brand]), [["moong-dal", "tata-sampann"]]);
});

const chanaReply = (candidates: string[]) => ({
  groceries: [{ raw: "do kilo चना", requested: true, itemWord: "चना", qtyPhrase: "do kilo", item: null, candidates, qty: 2, unit: "kg", brand: null, confidence: 0.6 }],
  advance: null,
  notes: [],
});

test("processCall: an ambiguous word with exactly one candidate in household history becomes that line (चना → kabuli-chana)", async () => {
  const hh: Household = { ...h, history: [...h.history, { at: "2026-11-18", lines: [{ item: "kabuli-chana", qty: 1, unit: "kg" }] }] };
  const { stt } = fakeStt("do kilo चना le aana", "hi");
  const { llm, calls } = fakeLlm(chanaReply(["kabuli-chana", "kala-chana"]));

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, hh, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit]), [["kabuli-chana", 2, "kg"]]);
  assert.equal(res.extraction.ambiguous, undefined);
  const schema = JSON.stringify(calls[0]!.schema);
  assert.match(schema, /"candidates"/);
  assert.match(schema, /kabuli-chana, kala-chana/);
});

test("processCall: an ambiguous word the household history doesn't settle comes back in extraction.ambiguous (चना, no history)", async () => {
  const { stt } = fakeStt("do kilo चना le aana", "hi");
  const { llm } = fakeLlm(chanaReply(["kabuli-chana", "kala-chana"]));

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries, []);
  // raw is the spoken item word alone: the card reads 'mean by "चना"?', not the whole span
  assert.deepEqual(res.extraction.ambiguous, [{ raw: "चना", qty: 2, unit: "kg", candidates: ["kabuli-chana", "kala-chana"] }]);
});

test("processCall: 'woh daal' resolves from a recent call's line, and recent notes reach the LLM", async () => {
  const { stt } = fakeStt("woh daal ek kilo aur le aana", "hi");
  const { llm, calls } = fakeLlm({
    groceries: [{ raw: "woh daal ek kilo", requested: true, itemWord: "daal", qtyPhrase: "ek kilo", item: null, candidates: ["toor-dal", "moong-dal", "masoor-dal"], qty: 1, unit: "kg", brand: null, confidence: 0.6 }],
    advance: null,
    notes: [],
  });
  const recent = [{ at: "2026-11-21T08:10:00+05:30", transcript: "aadha kilo moong daal le aana", lines: [{ item: "moong-dal", qty: 0.5, unit: "kg" as const }] }];

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm }, { recent });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit]), [["moong-dal", 1, "kg"]]);
  assert.match(calls[0]!.user, /recentNotes/);
  assert.match(calls[0]!.user, /aadha kilo moong daal le aana/);
  assert.match(calls[0]!.system, /recentNotes/);
});

test("processCall: a single candidate not in history becomes the line at confidence ≤ 0.5, not a one-option card", async () => {
  const { stt } = fakeStt("do kilo चना le aana", "hi");
  const { llm } = fakeLlm(chanaReply(["kala-chana"]));

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit, g.confidence]), [["kala-chana", 2, "kg", 0.5]]);
  assert.equal(res.extraction.ambiguous, undefined);
});

const cookOffText = "bhaiya kal Sunday nahi aaungi, 2 patti dhaniya 1 kilo pyaaz le lena";
const cookOffReply = (cookOff: string | null) => ({
  groceries: [
    { raw: "2 patti dhaniya", requested: true, itemWord: "dhaniya", qtyPhrase: "2 patti", item: "coriander", candidates: [], qty: 2, unit: "bunch", brand: null, confidence: 0.9 },
    { raw: "1 kilo pyaaz", requested: true, itemWord: "pyaaz", qtyPhrase: "1 kilo", item: "onion", candidates: [], qty: 1, unit: "kg", brand: null, confidence: 0.95 },
  ],
  advance: null,
  notes: ["kal Sunday nahi aaungi"],
  cookOff,
});
const mealReply = {
  cook: { meals: [{ slot: "lunch", dish: "Rajma chawal", macros: { kcal: 550, proteinG: 18, carbsG: 80, fiberG: 12, fatG: 10 }, steps: ["Soak rajma", "Pressure cook", "Serve with rice"], ingredients: [{ item: "rajma", qty: 400, unit: "g" }] }] },
  order: { meals: [{ slot: "lunch", dish: "Veg thali", macros: { kcal: 700, proteinG: 20, carbsG: 95, fiberG: 10, fatG: 22 } }] },
};
/** Answers each LLM call by schema: extraction, then the meal plan (or throws for it). */
function routedLlm(extraction: unknown, meals: unknown) {
  const calls: { user: string; schemaName: string }[] = [];
  const llm: Llm = {
    async json<T>(args: { system: string; user: string; schema: object; schemaName: string }) {
      calls.push(args);
      if (args.schemaName !== "meal_plan") return extraction as T;
      if (meals instanceof Error) throw meals;
      return meals as T;
    },
  };
  return { llm, calls };
}

test("processCall: the cook saying she's off tomorrow adds a meal-plan card for that day after the cart", async () => {
  const { stt } = fakeStt(cookOffText, "hi");
  const { llm, calls } = routedLlm(cookOffReply("2026-11-22"), mealReply);

  const res = await processCall({ audioPath: "x.wav", householdId: "h1" }, h, { stt, llm }, { now: new Date("2026-11-21T10:00:00+05:30") });

  assert.deepEqual(res.extraction.groceries.map((g) => [g.item, g.qty, g.unit]), [["coriander", 2, "bunch"], ["onion", 1, "kg"]]);
  assert.equal(res.extraction.cookOff, "2026-11-22");
  assert.match(calls[0]!.user, /Today: 2026-11-21 \(Saturday\)/);
  assert.deepEqual(res.actions.map((a) => a.type), ["cart", "meal-plan"]);
  const card = res.actions[1]!;
  assert.ok(card.type === "meal-plan");
  assert.deepEqual(card.options, ["cook", "order"]);
  assert.equal(card.plan.date, "2026-11-22");
  assert.equal(card.plan.order.meals[0]!.dish, "Veg thali");
});
