// Review the IndicVoices draft labels in one sitting.
//   node --env-file=.env eval/review.ts [--force]   → eval/out/review.md (gitignored: it quotes transcripts). Shows current gold (else the draft); suspicious clips first.
//   node eval/review.ts apply                       → ok/fix clips → eval/gold/indicvoices/<id>.json; drop → removed from gold.
// The English gloss and the flags come from one LLM call per clip, cached in eval/out/review-cache/ and keyed on transcript + draft.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { Extraction, GroceryLine, Unit } from "../src/contracts.ts";
import { UNITS } from "../src/contracts.ts";
import { IV_DIR, readJson, type Case } from "./dataset.ts";
import { openaiLlm } from "./pipeline.ts";

const DRAFTS = `${IV_DIR}/drafts`;
const GOLD = "eval/gold/indicvoices";
const OUT = "eval/out/review.md";
const CACHE = "eval/out/review-cache";
const items = new Set(readJson<string[]>("fixtures/items.json"));
const units = new Set<string>(UNITS);

// Label rulings (integrator, 2026-11-21). Price queries match fixtures/cases.
const RULES = `- A price or availability question that names a quantity still produces a line.
- Drop lines whose item has no id in fixtures/items.json. Never force a near id.
- Keep a brand only if the speaker said it, as its id from src/indic/brands.ts (else a plain slug). Drafts saw household brands (atta=aashirvaad, milk=amul, rice=india-gate), so delete leaked ones.
- "Repeat my last order" with no item spoken: no line. The draft may have filled it in from household history.
- Replace X with Y: one line for Y, with Y's quantity, if Y has an item id; else no line. X is never a line.
- Remove or cancel X: no line.
- No usable grocery intent (a complaint, a cooking story), or audio you'd not trust: drop.`;

interface Check {
  gloss: string;
  intent: "add" | "replace" | "remove" | "repeat-order" | "price-query" | "other";
  lines: { index: number; spoken: boolean; why: string }[];
}

const CHECK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["gloss", "intent", "lines"],
  properties: {
    gloss: { type: "string" },
    intent: { type: "string", enum: ["add", "replace", "remove", "repeat-order", "price-query", "other"] },
    lines: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "spoken", "why"],
        properties: { index: { type: "integer" }, spoken: { type: "boolean" }, why: { type: "string" } },
      },
    },
  },
};

const fmtLine = (l: GroceryLine) => `${l.qty} ${l.unit} ${l.item}${l.brand ? ` (${l.brand})` : ""}`;

async function check(c: Case, llm: ReturnType<typeof openaiLlm>): Promise<Check> {
  const key = createHash("sha1").update(JSON.stringify([c.transcript, c.gold.groceries])).digest("hex");
  const p = `${CACHE}/${c.id}.json`;
  if (existsSync(p)) {
    const hit = readJson<{ key: string; check: Check }>(p);
    if (hit.key === key) return hit.check;
  }
  const result = await llm.json<Check>({
    system: `You help a human audit grocery labels for Indian-language voice commands.
gloss: a faithful plain-English translation of the transcript (keep brand names and numbers as spoken).
intent: add, replace (swap one product for another), remove, repeat-order (repeat a previous order), price-query (asks price or availability), or other.
lines: for each numbered draft line, spoken = true only if the speaker clearly said that item with that quantity and unit, and the brand if one is given. If not, why = under 10 words.`,
    user: `Transcript (${c.lang}): ${c.transcript}\nDraft lines:\n${c.gold.groceries.map((l, i) => `${i}. ${fmtLine(l)} (span: "${l.raw}")`).join("\n") || "(none)"}`,
    schema: CHECK_SCHEMA,
    schemaName: "label_check",
  });
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(p, JSON.stringify({ key, check: result }));
  return result;
}

function flags(c: Case, k: Check): string[] {
  return [
    ...(["replace", "remove", "repeat-order", "price-query"].includes(k.intent) ? [`${k.intent} intent`] : []),
    ...c.gold.groceries.flatMap((l, i) => [
      ...(c.transcript.includes(l.raw) ? [] : [`"${fmtLine(l)}": span not in transcript`]),
      ...k.lines.filter((x) => x.index === i && !x.spoken).map((x) => `"${fmtLine(l)}": ${x.why}`),
    ]),
  ];
}

async function generate() {
  if (existsSync(OUT) && !process.argv.includes("--force")) {
    console.error(`${OUT} exists (it may hold your decisions). Run \`apply\`, or pass --force to regenerate.`);
    process.exit(1);
  }
  const llm = openaiLlm();
  // Show the current gold where it exists, so `apply` on an all-ok pass keeps it; flag where it departs from the draft.
  const reviewed = existsSync(GOLD) && readdirSync(GOLD).some((f) => f.endsWith(".json"));
  const fmtAll = (c: Case) => c.gold.groceries.map(fmtLine).join("; ") || "no lines";
  const checked = await Promise.all(
    readdirSync(DRAFTS).filter((f) => f.endsWith(".json")).sort().map(async (f) => {
      const draft = readJson<Case>(`${DRAFTS}/${f}`);
      const gold = existsSync(`${GOLD}/${f}`) ? readJson<Case>(`${GOLD}/${f}`) : undefined;
      const c = gold ?? draft;
      const k = await check(c, llm);
      const history = !reviewed ? [] : !gold ? [`dropped from gold (draft: ${fmtAll(draft)}); leave blank to keep it out`] : fmtAll(gold) !== fmtAll(draft) ? [`gold differs from draft (draft: ${fmtAll(draft)})`] : [];
      return { c, k, f: [...history, ...flags(c, k)] };
    }),
  );
  checked.sort((a, b) => Number(b.f.length > 0) - Number(a.f.length > 0) || a.c.id.localeCompare(b.c.id));
  const nFlagged = checked.filter((x) => x.f.length).length;
  const md = `# IndicVoices label review: ${checked.length} clips, ${nFlagged} flagged ⚠ (listed first)

For each clip, set \`decision:\` to **ok** (keep the lines as shown), **fix** (you edited the lines below it) or **drop** (leave the clip out of gold).
A line reads \`- <qty> <unit> <item> (<brand>)\`. Brand is optional; anything after \` #\` is ignored. Delete every line for "no groceries".
Units: ${UNITS.join(", ")}. Items: ids from fixtures/items.json. \`advance:\` takes none or an amount in ₹.
Blank decisions are skipped. When done: \`node eval/review.ts apply\` (it validates everything first and writes nothing if anything is wrong).

Rules:
${RULES}

Item ids: ${[...items].join(" ")}

${checked
  .map(({ c, f, k }, i) => `---
## ${i + 1}. ${f.length ? "⚠ " : ""}${c.id} (${c.lang})
${f.map((x) => `⚠ ${x}`).join("  \n")}

> ${c.transcript}
>
> EN: ${k.gloss}

decision:
${c.gold.groceries.map((l) => `- ${fmtLine(l)}   # "${l.raw}"`).join("\n")}
advance: ${c.gold.advance?.amount ?? "none"}
`)
  .join("\n")}`;
  mkdirSync("eval/out", { recursive: true });
  writeFileSync(OUT, md);
  console.log(`${OUT}: ${checked.length} clips, ${nFlagged} flagged`);
}

function apply() {
  const sections = readFileSync(OUT, "utf8").split(/^## /m).slice(1);
  const errors: string[] = [];
  const keep: Case[] = [];
  const drop: string[] = [];
  const blank: string[] = [];
  for (const s of sections) {
    const id = /(iv-[\w-]+)/.exec(s)?.[1];
    if (!id || !existsSync(`${DRAFTS}/${id}.json`)) {
      errors.push(`no draft for section "${s.split("\n")[0]}"`);
      continue;
    }
    const decision = /^decision:[ \t]*(\S*)/m.exec(s)?.[1]?.toLowerCase() ?? "";
    if (!decision) {
      blank.push(id);
      continue;
    }
    if (decision === "drop") {
      drop.push(id);
      continue;
    }
    if (decision !== "ok" && decision !== "fix") {
      errors.push(`${id}: decision "${decision}" is not ok, fix or drop`);
      continue;
    }
    const draft = readJson<Case>(`${DRAFTS}/${id}.json`);
    const groceries: GroceryLine[] = [];
    for (const raw of s.match(/^- .*$/gm) ?? []) {
      const text = raw.slice(2).replace(/\s+#.*$/, "").trim();
      const m = /^(\d+(?:\.\d+)?)\s+(\S+)\s+(\S+)(?:\s+\(([^)]+)\))?$/.exec(text);
      if (!m) {
        errors.push(`${id}: can't read line "${text}"`);
        continue;
      }
      const [, qty, unit, item, brand] = m as unknown as [string, string, string, string, string | undefined];
      if (!items.has(item)) errors.push(`${id}: unknown item "${item}"`);
      if (!units.has(unit)) errors.push(`${id}: unknown unit "${unit}"`);
      if (!(Number(qty) > 0)) errors.push(`${id}: bad qty ${qty}`);
      // raw isn't scored; keep the draft's span when the item survived review.
      const span = draft.gold.groceries.find((g) => g.item === item)?.raw ?? "";
      groceries.push({ raw: span, item, qty: Number(qty), unit: unit as Unit, confidence: 1, ...(brand ? { brand } : {}) });
    }
    const adv = /^advance:[ \t]*(\S*)/m.exec(s)?.[1] ?? "none";
    if (adv !== "none" && !(Number(adv) > 0)) errors.push(`${id}: advance "${adv}" is not none or an amount`);
    const gold: Extraction = { groceries, ...(adv !== "none" ? { advance: { amount: Number(adv) } } : {}), notes: draft.gold.notes };
    keep.push({ ...draft, gold });
  }
  if (errors.length) {
    console.error(`nothing written; fix these in ${OUT}:\n  ${errors.join("\n  ")}`);
    process.exit(1);
  }
  mkdirSync(GOLD, { recursive: true });
  for (const c of keep) writeFileSync(`${GOLD}/${c.id}.json`, JSON.stringify(c, null, 2) + "\n");
  for (const id of drop) rmSync(`${GOLD}/${id}.json`, { force: true });
  console.log(`${keep.length} written to ${GOLD}, ${drop.length} dropped, ${blank.length} not reviewed yet${blank.length ? `: ${blank.join(" ")}` : ""}`);
}

await (process.argv[2] === "apply" ? apply() : generate());
