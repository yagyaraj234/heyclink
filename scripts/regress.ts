// Regression run against a live server: every fixtures/cases/*.json as a transcript, plus audio when
// fixtures/cases/<id>.<ext> exists locally (audio is never committed). Exits 1 on any failure.
// Usage: BASE_URL=https://host pnpm regress   (default http://localhost:3000)
// Approving carts mutates household h1, so the run ends with POST /households/h1/reset.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CallResult, Extraction } from "../src/contracts.ts";
import { scoreExtraction, summarizeLatency } from "../eval/score.ts";

const BASE = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const DIR = join(import.meta.dirname, "../fixtures/cases");
const AUDIO: Record<string, string> = { webm: "audio/webm", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg", mp3: "audio/mpeg" };

interface Case { id: string; lang: string; transcript: string; gold: Extraction }
interface Row { case: string; mode: string; score: string; cards: string; approve: string; totalMs: number; fails: string[] }

const post = (path: string, body: BodyInit, contentType: string) =>
  fetch(BASE + path, { method: "POST", headers: { "content-type": contentType }, body });

async function run(c: Case, mode: string, req: () => Promise<Response>): Promise<Row> {
  const row: Row = { case: c.id, mode, score: "-", cards: "-", approve: "-", totalMs: NaN, fails: [] };
  try {
    const res = await req();
    if (res.status !== 201) throw new Error(`POST /calls ${res.status}: ${(await res.text()).slice(0, 120)}`);
    const call = (await res.json()) as CallResult;
    row.totalMs = call.timings.totalMs;

    const s = scoreExtraction(c.gold, call.extraction);
    row.score = `${s.lineExact}/${s.goldLines} exact, ${s.predLines} pred, brand ${s.brandCorrect}/${s.brandGold}, adv ${s.advanceCorrect ? "ok" : "x"}`;
    if (s.lineExact !== s.goldLines || s.predLines !== s.goldLines) row.fails.push("lines");
    if (s.brandCorrect !== s.brandGold) row.fails.push("brand");
    if (!s.advanceCorrect) row.fails.push("advance");

    const types = call.actions.map((a) => a.type);
    row.cards = types.join(",") || "none";
    if (c.gold.groceries.length && !types.includes("cart")) row.fails.push("no cart card");
    const adv = call.actions.find((a) => a.type === "advance");
    if (c.gold.advance && !adv?.upiUrl?.startsWith("upi://")) row.fails.push("no advance upi card");

    const approved: string[] = [];
    for (const a of call.actions) {
      if (a.type === "question") continue;
      const r = await post(`/actions/${a.id}/approve`, "{}", "application/json");
      const body = (await r.json().catch(() => ({}))) as { status?: string; upiUrl?: string };
      const ok = r.ok && body.status === "approved" && (a.type !== "advance" || !!body.upiUrl?.startsWith("upi://"));
      approved.push(`${a.type}:${ok ? "ok" : r.status}`);
      if (!ok) row.fails.push(`approve ${a.type}`);
    }
    row.approve = approved.join(",") || "-";
  } catch (e) {
    row.fails.push((e as Error).message);
  }
  return row;
}

const cases = readdirSync(DIR).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(DIR, f), "utf8")) as Case);
const rows: Row[] = [];
for (const c of cases) {
  rows.push(await run(c, "text", () =>
    post("/calls", JSON.stringify({ transcript: c.transcript, lang: c.lang, householdId: "h1" }), "application/json")));
  for (const [ext, type] of Object.entries(AUDIO)) {
    const file = join(DIR, `${c.id}.${ext}`);
    if (existsSync(file)) rows.push(await run(c, ext, () => post(`/calls?householdId=h1&lang=${c.lang}`, readFileSync(file), type)));
  }
}

console.log(`regress ${BASE}`);
console.table(rows.map((r) => ({
  case: r.case, mode: r.mode, result: r.fails.length ? "FAIL" : "pass", score: r.score, cards: r.cards, approve: r.approve,
  totalMs: Math.round(r.totalMs), why: r.fails.join("; "),
})));
for (const mode of new Set(rows.map((r) => r.mode))) {
  const { n, p50, p95, p99 } = summarizeLatency(rows.filter((r) => r.mode === mode && Number.isFinite(r.totalMs)).map((r) => r.totalMs));
  console.log(`totalMs ${mode}: n=${n} p50=${Math.round(p50)} p95=${Math.round(p95)} p99=${Math.round(p99)}`);
}
// Reset even after failures so the demo box is left as it was; a failed reset fails the run.
const reset = await post("/households/h1/reset", "{}", "application/json").then((r) => r.ok, () => false);
console.log(`reset h1: ${reset ? "ok" : "FAILED"}`);
const failed = rows.filter((r) => r.fails.length).length + (reset ? 0 : 1);
console.log(failed ? `${failed} FAILED (of ${rows.length} cases + reset)` : `all ${rows.length} passed`);
process.exitCode = failed ? 1 : 0;
