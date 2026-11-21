// Draft gold for IndicVoices clips, then hand-review it.
//   node --env-file-if-exists=.env eval/prelabel.ts          → drafts in eval/data/indicvoices/drafts/ (gitignored)
//   node eval/prelabel.ts review                             → y / e / s / q per clip; accepted → eval/gold/indicvoices/<id>.json
// Drafts come from our own harness, so they bias the reviewer toward it. Read the transcript, not the draft.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import type { Extraction, Household } from "../src/contracts.ts";
import { UNITS } from "../src/contracts.ts";
import { IV_DIR as DATA_DIR, readJson as read, type Case, type ClipMeta } from "./dataset.ts";
import { openaiLlm, processTranscript } from "./pipeline.ts";

const DRAFTS = `${DATA_DIR}/drafts`;
const GOLD = "eval/gold/indicvoices";
const items = new Set(read<string[]>("fixtures/items.json"));
const units = new Set<string>(UNITS);

function problems(e: Extraction): string[] {
  return e.groceries.flatMap((g) => [
    ...(items.has(g.item) ? [] : [`unknown item "${g.item}"`]),
    ...(units.has(g.unit) ? [] : [`unknown unit "${g.unit}"`]),
    ...(Number.isFinite(g.qty) && g.qty > 0 ? [] : [`bad qty ${g.qty} for ${g.item}`]),
  ]);
}

async function draft() {
  mkdirSync(DRAFTS, { recursive: true });
  const household = read<Household>("fixtures/household.json");
  let llm: ReturnType<typeof openaiLlm> | undefined;
  try {
    llm = openaiLlm();
  } catch (e) {
    console.warn(`no LLM (${(e as Error).message}); writing empty drafts to label by hand`);
  }
  for (const c of read<ClipMeta[]>(`${DATA_DIR}/manifest.json`)) {
    const out = `${DRAFTS}/${c.id}.json`;
    if (existsSync(out)) continue;
    const gold = llm ? await processTranscript(c.text, c.lang, household, { llm }) : { groceries: [], notes: [] };
    const draftCase: Case = { id: c.id, source: `${c.source} ${c.task} (CC-BY-4.0 upstream)`, lang: c.lang, transcript: c.text, gold };
    writeFileSync(out, JSON.stringify(draftCase, null, 2) + "\n");
    console.log(c.id, gold.groceries.map((g) => `${g.qty}${g.unit} ${g.item}`).join(", ") || "(none)");
  }
}

async function review() {
  mkdirSync(GOLD, { recursive: true });
  const rl = createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async () => {
    process.stdout.write("> ");
    return ((await lines.next()).value ?? "q").trim().toLowerCase(); // EOF → quit
  };
  const todo = readdirSync(DRAFTS).filter((f) => f.endsWith(".json") && !existsSync(`${GOLD}/${f}`)).sort();
  console.log(`${todo.length} to review. y = accept, e = edit in $EDITOR, s = skip, q = quit
Rules (match fixtures/cases):
  - A price/availability question or a narrative mention with a quantity still produces a line.
  - Drop lines whose item has no id in fixtures/items.json. Never force a near id.
  - Keep a brand only if the speaker said it. Drafts see household brands, so delete leaked "amul" etc.
  - No grocery intent at all → s (skip), so the clip stays out of the eval.\n`);
  for (const [i, f] of todo.entries()) {
    const path = `${DRAFTS}/${f}`;
    for (;;) {
      const c = read<Case>(path);
      const bad = problems(c.gold);
      console.log(`\n[${i + 1}/${todo.length}] ${c.id} (${c.lang})\n  ${c.transcript}\n`);
      for (const g of c.gold.groceries) console.log(`  - ${g.qty} ${g.unit} ${g.item}${g.brand ? ` [${g.brand}]` : ""}   ← "${g.raw}"`);
      if (!c.gold.groceries.length) console.log("  (no groceries)");
      if (c.gold.advance) console.log(`  advance ₹${c.gold.advance.amount}`);
      for (const b of bad) console.log(`  ! ${b}`);
      const a = await ask();
      if (a === "q") return rl.close();
      if (a === "s") break;
      if (a === "e") {
        rl.pause();
        spawnSync(process.env.EDITOR ?? "vi", [path], { stdio: "inherit" });
        rl.resume();
        continue;
      }
      if (a === "y") {
        if (bad.length) {
          console.log("  fix the problems above first (e)");
          continue;
        }
        const gold = { ...c.gold, groceries: c.gold.groceries.map((g) => ({ ...g, confidence: 1 })) };
        writeFileSync(`${GOLD}/${f}`, JSON.stringify({ ...c, gold }, null, 2) + "\n");
        break;
      }
    }
  }
  rl.close();
}

await (process.argv[2] === "review" ? review() : draft());
