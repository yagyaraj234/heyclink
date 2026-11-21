// Score every real clip for each STT provider × {plain, harness}; write eval/out/results.{json,md}.
//   node --env-file-if-exists=.env eval/run.ts [--provider openai] [--mode harness] [--set recorded] [--limit 5] [--fresh] [--gold eval/data/indicvoices/drafts]
// STT results are cached in eval/out/stt-cache/ (with their measured sttMs) so re-runs only pay for extraction; --fresh ignores the cache.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { CallResult, Extraction, Household, Stt, Transcript } from "../src/contracts.ts";
import { IV_DIR, RECORDED_AUDIO_DIR, readCases, readJson, type Case, type ClipMeta } from "./dataset.ts";
import { openaiLlm, openaiStt, processCall, sarvamStt, whisperCppStt } from "./pipeline.ts";
import { scoreExtraction, summarizeLatency, type ExtractionScore } from "./score.ts";

const { values: args } = parseArgs({
  options: {
    provider: { type: "string", multiple: true },
    mode: { type: "string", multiple: true },
    set: { type: "string", multiple: true },
    limit: { type: "string" },
    fresh: { type: "boolean", default: false },
    gold: { type: "string", default: "eval/gold/indicvoices" }, // IndicVoices gold dir; anything else is reported as provisional
  },
});

// whisper-cpp spawns whisper-cli per call (model reload each time), so its sttMs includes load time; see the adapter.
const PROVIDERS: Record<string, () => Stt> = { openai: openaiStt, sarvam: sarvamStt, "whisper-cpp": () => whisperCppStt() };
const MODES = ["plain", "harness"] as const;
const OUT = "eval/out";
const CACHE = `${OUT}/stt-cache`;

interface Clip extends Case {
  set: "recorded" | "indicvoices";
  audioPath: string;
}

function wav16k(src: string): string {
  if (src.endsWith(".wav")) return src;
  const out = `${RECORDED_AUDIO_DIR}/wav/${src.split("/").pop()!.replace(/\.[^.]+$/, "")}.wav`;
  if (!existsSync(out)) {
    mkdirSync(`${RECORDED_AUDIO_DIR}/wav`, { recursive: true });
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-ar", "16000", "-ac", "1", out]);
  }
  return out;
}

function loadClips(): { clips: Clip[]; missingAudio: string[] } {
  const missingAudio: string[] = [];
  const recFiles = existsSync(RECORDED_AUDIO_DIR) ? readdirSync(RECORDED_AUDIO_DIR) : [];
  const recorded = readCases("eval/gold/recorded").flatMap((c): Clip[] => {
    const f = recFiles.find((x) => x.replace(/\.[^.]+$/, "") === c.id);
    if (!f) return (missingAudio.push(c.id), []);
    return [{ ...c, set: "recorded", audioPath: wav16k(`${RECORDED_AUDIO_DIR}/${f}`) }];
  });
  const manifest = existsSync(`${IV_DIR}/manifest.json`) ? readJson<ClipMeta[]>(`${IV_DIR}/manifest.json`) : [];
  const iv = readCases(args.gold).flatMap((c): Clip[] => {
    const m = manifest.find((x) => x.id === c.id);
    if (!m || !existsSync(m.audioPath)) return (missingAudio.push(c.id), []);
    return [{ ...c, set: "indicvoices", audioPath: m.audioPath }];
  });
  // Headline numbers are real speech only: synthetic/TTS clips never enter this run.
  const clips = [...recorded, ...iv].filter((c) => !/synthetic|tts/i.test(c.source));
  return { clips: args.set ? clips.filter((c) => args.set!.includes(c.set)) : clips, missingAudio };
}

/** Wraps an Stt with a disk cache; a hit replays the transcript and the sttMs measured when it was fetched. */
function cachedStt(inner: Stt, key: (audioPath: string) => string, hits: Map<string, number>): Stt {
  return {
    async transcribe(audioPath, opts) {
      const p = `${CACHE}/${key(audioPath)}.json`;
      if (!args.fresh && existsSync(p)) {
        const c = readJson<{ transcript: Transcript; sttMs: number }>(p);
        hits.set(audioPath, c.sttMs);
        return c.transcript;
      }
      const t0 = performance.now();
      const transcript = await inner.transcribe(audioPath, opts);
      mkdirSync(p.slice(0, p.lastIndexOf("/")), { recursive: true });
      writeFileSync(p, JSON.stringify({ transcript, sttMs: performance.now() - t0 }));
      return transcript;
    },
  };
}

// ---- WER ---------------------------------------------------------------------
// Cross-script WER is meaningless (romanized reference vs Devanagari hypothesis), so such clips get null.
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
const script = (s: string) => (/[ऀ-ॿ]/.test(s) ? "deva" : /[ఀ-౿]/.test(s) ? "telu" : "latn");
function wordErrors(ref: string, hyp: string): { edits: number; refWords: number } | null {
  if (script(ref) !== script(hyp)) return null;
  const r = words(ref), h = words(hyp);
  let prev = Array.from({ length: h.length + 1 }, (_, j) => j);
  for (let i = 1; i <= r.length; i++) {
    const cur = [i];
    for (let j = 1; j <= h.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (r[i - 1] === h[j - 1] ? 0 : 1));
    prev = cur;
  }
  return { edits: prev[h.length]!, refWords: r.length };
}

// ---- Run ---------------------------------------------------------------------
interface ClipResult {
  id: string;
  set: Clip["set"];
  lang: Clip["lang"];
  provider: string;
  mode: (typeof MODES)[number];
  error?: string;
  hyp?: string;
  pred?: Extraction;
  score?: ExtractionScore;
  wer?: { edits: number; refWords: number } | null;
  timings?: CallResult["timings"];
}

const household = readJson<Household>("fixtures/household.json");
const { clips: allClips, missingAudio } = loadClips();
const clips = args.limit ? allClips.slice(0, Number(args.limit)) : allClips;
if (missingAudio.length) console.warn(`no audio for ${missingAudio.length} gold cases: ${missingAudio.join(" ")}`);
console.log(`${clips.length} clips`);

const llm = openaiLlm();
const results: ClipResult[] = [];
for (const provider of Object.keys(PROVIDERS).filter((p) => !args.provider || args.provider.includes(p))) {
  for (const mode of MODES.filter((m) => !args.mode || args.mode.includes(m))) {
    const hits = new Map<string, number>();
    const byPath = new Map(clips.map((c) => [c.audioPath, c.id]));
    const stt = cachedStt(PROVIDERS[provider]!(), (p) => `${provider}/${mode}/${byPath.get(p)}`, hits);
    for (const c of clips) {
      const base = { id: c.id, set: c.set, lang: c.lang, provider, mode };
      try {
        const r = await processCall({ audioPath: c.audioPath, householdId: household.id, lang: c.lang }, household, { stt, llm }, { harness: mode === "harness" });
        const cachedMs = hits.get(c.audioPath);
        const timings = cachedMs === undefined ? r.timings : { ...r.timings, sttMs: cachedMs, totalMs: r.timings.totalMs - r.timings.sttMs + cachedMs };
        results.push({ ...base, hyp: r.transcript.text, pred: r.extraction, score: scoreExtraction(c.gold, r.extraction), wer: wordErrors(c.transcript, r.transcript.text), timings });
        process.stdout.write(".");
      } catch (e) {
        results.push({ ...base, error: (e as Error).message.slice(0, 300) });
        process.stdout.write("x");
      }
    }
    console.log(` ${provider}/${mode}`);
  }
}

// ---- Aggregate (micro-averaged over lines; latency over clips) ----------------
const groups = new Map<string, ClipResult[]>();
for (const r of results) {
  const k = [r.provider, r.mode, r.set, r.lang].join("|");
  groups.set(k, [...(groups.get(k) ?? []), r]);
}
const sum = (rs: ClipResult[], f: (s: ExtractionScore) => number) => rs.reduce((a, r) => a + (r.score ? f(r.score) : 0), 0);
const rows = [...groups.entries()].map(([k, rs]) => {
  const [provider, mode, set, lang] = k.split("|");
  const ok = rs.filter((r) => r.score);
  const wers = ok.flatMap((r) => (r.wer ? [r.wer] : []));
  const lat = (f: (t: CallResult["timings"]) => number) => summarizeLatency(ok.map((r) => f(r.timings!)));
  return {
    provider, mode, set, lang,
    clips: rs.length,
    errors: rs.length - ok.length,
    goldLines: sum(ok, (s) => s.goldLines),
    predLines: sum(ok, (s) => s.predLines),
    lineExact: sum(ok, (s) => s.lineExact),
    itemOnly: sum(ok, (s) => s.itemOnly),
    brandGold: sum(ok, (s) => s.brandGold),
    brandCorrect: sum(ok, (s) => s.brandCorrect),
    advanceCorrect: ok.filter((r) => r.score!.advanceCorrect).length,
    advanceGold: ok.filter((r) => r.score!.advanceGold).length,
    advancePred: ok.filter((r) => r.score!.advancePred).length,
    advanceTp: ok.filter((r) => r.score!.advanceGold && r.score!.advanceCorrect).length,
    wer: wers.length ? wers.reduce((a, w) => a + w.edits, 0) / wers.reduce((a, w) => a + w.refWords, 0) : null,
    werClips: wers.length,
    latency: { totalMs: lat((t) => t.totalMs), sttMs: lat((t) => t.sttMs), extractMs: lat((t) => t.extractMs), planMs: lat((t) => t.planMs) },
  };
});

mkdirSync(OUT, { recursive: true });
writeFileSync(`${OUT}/results.json`, JSON.stringify({ generatedAt: new Date().toISOString(), missingAudio, rows, clips: results }, null, 2));

const pct = (a: number, b: number) => (b ? `${((100 * a) / b).toFixed(0)}%` : "–");
const f1 = (tp: number, gold: number, pred: number) => (gold + pred ? ((2 * tp) / (gold + pred)).toFixed(2) : "–");
const ms = (l: { p50: number; p95: number; p99: number }) => `${Math.round(l.p50)} / ${Math.round(l.p95)} / ${Math.round(l.p99)}`;

// Worst clips: sum over every provider×mode of missed gold lines + extra pred lines + brand misses + advance mismatch (an error counts as all gold missed + 1).
const goldById = new Map(clips.map((c) => [c.id, c]));
const badness = (r: ClipResult) =>
  r.score
    ? r.score.goldLines + r.score.predLines - 2 * r.score.lineExact + r.score.brandGold - r.score.brandCorrect + (r.score.advanceCorrect ? 0 : 1)
    : goldById.get(r.id)!.gold.groceries.length + 1;
const fmt = (e: Extraction) =>
  [...e.groceries.map((l) => `${l.qty} ${l.unit} ${l.item}${l.brand ? ` (${l.brand})` : ""}`), ...(e.advance ? [`advance ₹${e.advance.amount}`] : [])].join("; ") || "∅";
const cell = (t: string) => t.replace(/\|/g, "\\|").replace(/\n/g, " ");
const worst = [...Map.groupBy(results, (r) => r.id).entries()]
  .map(([id, rs]) => ({ id, rs, bad: rs.reduce((a, r) => a + badness(r), 0) }))
  .filter((w) => w.bad > 0)
  .sort((a, b) => b.bad - a.bad)
  .slice(0, 10);

const provisional = args.gold !== "eval/gold/indicvoices";
const md = `# ${provisional ? `PROVISIONAL: draft labels, n=${clips.length}` : "Eval results"}

Generated ${new Date().toISOString()}. Real speech only (self-recorded cook notes + IndicVoices); no synthetic clips.
${provisional ? `
> IndicVoices gold read from \`${args.gold}\`: unreviewed drafts that \`eval/prelabel.ts\` produced by running our own harness extraction on the human transcript.
> So extraction F1 here is partly circular: it mostly measures how well extraction survives STT errors, not whether it's correct. Rerun against reviewed \`eval/gold/indicvoices/\` before quoting.
> WER is not provisional: its reference is the human IndicVoices transcript.
` : ""}${missingAudio.length ? `\nNo audio yet for ${missingAudio.length} gold cases (${missingAudio.filter((id) => id.startsWith("rec-")).length} recorded); they are not in this table.\n` : ""}
- **item F1**: right item, any qty/unit. **qty+unit F1**: item + qty + unit match (g↔kg, ml↔l normalized), R / P in brackets. Micro-averaged over lines.
- **brand**: over gold lines that name a brand. **advance**: F1 over clips with an advance, then gold advances and invented (FP) advances.
- **WER**: corpus WER over clips whose reference and hypothesis share a script (n in brackets).
- Latency is p50 / p95 / p99 in ms. Total = audio in → actions ready (\`timings.totalMs\`). whisper-cpp stt includes a per-call model reload.

| provider | mode | set | lang | clips (err) | item F1 | qty+unit F1 (R / P) | brand | advance F1 (gold, FP) | WER | total ms | stt ms | extract ms | plan ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
${rows
  .map((r) =>
    [
      r.provider, r.mode, r.set, r.lang, `${r.clips} (${r.errors})`,
      f1(r.itemOnly, r.goldLines, r.predLines),
      `${f1(r.lineExact, r.goldLines, r.predLines)} (${pct(r.lineExact, r.goldLines)} / ${pct(r.lineExact, r.predLines)})`,
      pct(r.brandCorrect, r.brandGold),
      `${f1(r.advanceTp, r.advanceGold, r.advancePred)} (${r.advanceGold}, ${r.advancePred - r.advanceTp})`,
      r.wer === null ? "–" : `${(100 * r.wer).toFixed(1)}% (${r.werClips})`,
      ms(r.latency.totalMs), ms(r.latency.sttMs), ms(r.latency.extractMs), ms(r.latency.planMs),
    ].join(" | "),
  )
  .map((l) => `| ${l} |`)
  .join("\n")}

## ${worst.length} worst clips

Ranked by missed + extra lines + brand misses + advance mismatches summed over every provider × mode. Score per row is the same count for that run.

${worst
  .map(({ id, rs, bad }) => {
    const c = goldById.get(id)!;
    return `### ${id} (${bad})

Gold transcript: ${c.transcript}
Gold: **${fmt(c.gold)}**

| run | bad | STT hyp | pred |
|---|---|---|---|
${rs.map((r) => `| ${r.provider}/${r.mode} | ${badness(r)} | ${cell(r.hyp ?? `error: ${r.error}`)} | ${r.pred ? cell(fmt(r.pred)) : "–"} |`).join("\n")}
`;
  })
  .join("\n")}`;
writeFileSync(`${OUT}/results.md`, md);
console.log(md);
