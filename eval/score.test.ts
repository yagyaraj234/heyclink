import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Extraction, GroceryLine } from "../src/contracts.ts";
import { scoreExtraction, summarizeLatency } from "./score.ts";

test("summarizeLatency uses nearest-rank percentiles", () => {
  // 1..20 shuffled. Nearest rank: p50 → rank 10, p95 → rank 19, p99 → rank 20.
  const ms = [7, 20, 3, 14, 1, 18, 10, 5, 12, 16, 2, 19, 9, 4, 15, 11, 6, 17, 8, 13];
  assert.deepEqual(summarizeLatency(ms), { n: 20, p50: 10, p95: 19, p99: 20 });
});

test("summarizeLatency on one sample and on none", () => {
  assert.deepEqual(summarizeLatency([420]), { n: 1, p50: 420, p95: 420, p99: 420 });
  assert.deepEqual(summarizeLatency([]), { n: 0, p50: 0, p95: 0, p99: 0 });
});

test("scoreExtraction: identical extraction scores full marks", () => {
  const c = JSON.parse(readFileSync("fixtures/cases/cook-hinglish-01.json", "utf8"));
  assert.deepEqual(scoreExtraction(c.gold, c.gold), {
    goldLines: 3, predLines: 3, lineExact: 3, itemOnly: 3, brandGold: 2, brandCorrect: 2, advanceCorrect: true, advanceGold: true, advancePred: true,
  });
});

test("scoreExtraction: unit normalization, partial credit, duplicates, missing advance", () => {
  const line = (item: string, qty: number, unit: GroceryLine["unit"], brand?: string): GroceryLine =>
    ({ raw: "", item, qty, unit, confidence: 1, ...(brand ? { brand } : {}) });
  const gold: Extraction = {
    groceries: [line("onion", 1.5, "kg"), line("green-chilli", 0.25, "kg"), line("curd", 0.5, "l"), line("atta", 2, "kg", "aashirvaad")],
    advance: { amount: 500 },
    notes: [],
  };
  const pred: Extraction = {
    groceries: [
      line("green-chilli", 250, "g"), // exact after g→kg
      line("onion", 2, "kg"), // item only (wrong qty)
      line("onion", 1.5, "kg"), // exact; the 2 kg onion is then an unmatched extra
      line("curd", 1, "packet"), // item only (wrong unit)
      line("atta", 2, "kg", "pillsbury"), // exact line, wrong brand
      line("tomato", 1, "kg"), // hallucinated
    ],
    notes: [],
  };
  assert.deepEqual(scoreExtraction(gold, pred), {
    goldLines: 4, predLines: 6, lineExact: 3, itemOnly: 4, brandGold: 1, brandCorrect: 0, advanceCorrect: false, advanceGold: true, advancePred: false,
  });
  assert.equal(scoreExtraction({ groceries: [], notes: [] }, { groceries: [], notes: [] }).advanceCorrect, true);
  assert.equal(scoreExtraction({ groceries: [], notes: [] }, { groceries: [], advance: { amount: 500 }, notes: [] }).advanceCorrect, false);
});

test("scoreExtraction: advance presence flags for precision/recall", () => {
  const none: Extraction = { groceries: [], notes: [] };
  const adv = (amount: number): Extraction => ({ groceries: [], advance: { amount }, notes: [] });
  const flags = (g: Extraction, p: Extraction) => {
    const s = scoreExtraction(g, p);
    return [s.advanceGold, s.advancePred, s.advanceCorrect];
  };
  assert.deepEqual(flags(none, adv(500)), [false, true, false]); // invented advance
  assert.deepEqual(flags(adv(500), adv(500)), [true, true, true]);
  assert.deepEqual(flags(adv(500), adv(1000)), [true, true, false]);
  assert.deepEqual(flags(adv(500), none), [true, false, false]);
});
