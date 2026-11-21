import type { Extraction, GroceryLine, LatencySummary } from "../src/contracts.ts";

/**
 * Per-clip counts; aggregate (micro-average) at table level, never average per-clip ratios.
 *
 * Matching is one-to-one per item: each gold line claims at most one pred line, exact matches first,
 * so a duplicated pred line never counts twice and extra pred lines only show up in `predLines`
 * (precision = lineExact / predLines, recall = lineExact / goldLines).
 *
 * Partial credit:
 * - lineExact: item + qty + unit agree. g/kg and ml/l are normalized first (250 g == 0.25 kg).
 *   Other unit pairs never match (1 kg curd != 1 packet curd).
 * - itemOnly: item agrees, qty/unit may be wrong. lineExact <= itemOnly.
 * - brandCorrect: over gold lines that carry a brand, the matched pred line has the same brand.
 * - advanceCorrect: both absent, or both present with equal amount. Reason is not scored.
 * `raw`, `confidence` and `notes` are not scored.
 */
export interface ExtractionScore {
  goldLines: number;
  predLines: number;
  lineExact: number;
  itemOnly: number;
  brandGold: number;
  brandCorrect: number;
  advanceCorrect: boolean;
}

const base = (l: GroceryLine) =>
  l.unit === "g" ? { qty: l.qty / 1000, unit: "kg" } : l.unit === "ml" ? { qty: l.qty / 1000, unit: "l" } : l;

function sameLine(a: GroceryLine, b: GroceryLine): boolean {
  const x = base(a), y = base(b);
  return a.item === b.item && x.unit === y.unit && Math.abs(x.qty - y.qty) < 1e-6;
}

export function scoreExtraction(gold: Extraction, pred: Extraction): ExtractionScore {
  const free = [...pred.groceries];
  const matched = gold.groceries.map(() => undefined as GroceryLine | undefined);
  let lineExact = 0;
  for (const [pass, ok] of [[0, sameLine], [1, (a: GroceryLine, b: GroceryLine) => a.item === b.item]] as const) {
    gold.groceries.forEach((g, i) => {
      if (matched[i]) return;
      const j = free.findIndex((p) => ok(g, p));
      if (j < 0) return;
      matched[i] = free.splice(j, 1)[0];
      if (pass === 0) lineExact++;
    });
  }
  const branded = gold.groceries.map((g, i) => [g, matched[i]] as const).filter(([g]) => g.brand);
  return {
    goldLines: gold.groceries.length,
    predLines: pred.groceries.length,
    lineExact,
    itemOnly: matched.filter(Boolean).length,
    brandGold: branded.length,
    brandCorrect: branded.filter(([g, p]) => p?.brand === g.brand).length,
    advanceCorrect: gold.advance?.amount === pred.advance?.amount,
  };
}

/** Nearest-rank percentile: the value at rank ceil(p/100 * n) in sorted order. */
export function summarizeLatency(ms: number[]): LatencySummary {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.max(1, Math.ceil((p * s.length) / 100)) - 1] ?? 0;
  return { n: s.length, p50: at(50), p95: at(95), p99: at(99) };
}
