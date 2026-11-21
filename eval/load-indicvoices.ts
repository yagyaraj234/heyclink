// Pull IndicVoices clips that mention quantities into eval/data/indicvoices/ (gitignored).
// Usage: HF_TOKEN=... node --env-file-if-exists=.env eval/load-indicvoices.ts [--hi-bigbasket 40] [--hi-cooking 20] [--te 20]
import { DuckDBInstance } from "@duckdb/node-api";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { IV_DIR as DATA_DIR, type ClipMeta } from "./dataset.ts";

const { values: n } = parseArgs({
  options: {
    "hi-bigbasket": { type: "string", default: "40" },
    "hi-cooking": { type: "string", default: "20" },
    te: { type: "string", default: "20" },
  },
});

const HF = "https://huggingface.co/datasets";
const auth: RequestInit = process.env.HF_TOKEN ? { headers: { authorization: `Bearer ${process.env.HF_TOKEN}` } } : {};
// HF rate-limits hits on /resolve/ (anonymous: 3000 per 5 min) and every DuckDB range read goes through it.
// Resolve each shard's redirect once and hand DuckDB the signed CDN URL, which isn't counted (valid ~1h). `*` in the signature is escaped because DuckDB reads it as a glob.
async function cdn(u: string): Promise<string> {
  const r = await fetch(u, { ...auth, method: "HEAD", redirect: "manual" });
  if (r.status === 429) throw new Error(`HF rate limit; retry in ${r.headers.get("retry-after")}s or set HF_TOKEN`);
  return r.headers.get("location") ?? u;
}
const list = async (urls: string[]) => `[${(await Promise.all(urls.map(cdn))).map((u) => `'${u.replaceAll("*", "%2A").replaceAll("'", "''")}'`).join(",")}]`;
const hiFiles = await list(Array.from({ length: 10 }, (_, i) => `${HF}/SPRINGLab/IndicVoices-R_Hindi/resolve/main/data/train-0000${i}-of-00010.parquet`));
const teApi = (await (await fetch("https://huggingface.co/api/datasets/eswardivi/IndicVoices", auth)).json()) as { siblings: { rfilename: string }[] };
const teFiles = await list(teApi.siblings.map((s) => s.rfilename).filter((f) => f.startsWith("telugu_train/") && f.endsWith(".parquet")).map((f) => `${HF}/eswardivi/IndicVoices/resolve/main/${f}`));

// Unit words only: bare fractions (आधा, पाव) also match inside other words (आधार, पावडर).
const HI_QTY = "किलो|ग्राम|लीटर|पैकेट|दर्जन|गड्डी";
const TE_QTY = "కిలో|గ్రాము|లీటర్|ప్యాకెట్|డజన్|కట్ట";

const jobs = [
  { files: hiFiles, lang: "hi", task: "Bigbasket Commands", tag: "hi-bigbasket", dur: "duration", re: HI_QTY, limit: Number(n["hi-bigbasket"]), source: "SPRINGLab/IndicVoices-R_Hindi" },
  { files: hiFiles, lang: "hi", task: "KYP - Cooking", tag: "hi-cooking", dur: "duration", re: HI_QTY, limit: Number(n["hi-cooking"]), source: "SPRINGLab/IndicVoices-R_Hindi" },
  { files: teFiles, lang: "te", task: "Bigbasket Commands", tag: "te-bigbasket", dur: "audio_raw_duration", re: TE_QTY, limit: Number(n.te), source: "eswardivi/IndicVoices telugu_train" },
] as const;

const db = await DuckDBInstance.create();
const con = await db.connect();
await con.run("INSTALL httpfs; LOAD httpfs; SET http_retries = 8; SET http_retry_wait_ms = 15000; SET http_retry_backoff = 2;");
// Anonymous HF reads hit 429 fast (3000 requests / 5 min). Set HF_TOKEN, or `hf auth login` (credential_chain reads its token file).
await con.run(process.env.HF_TOKEN ? `CREATE SECRET (TYPE huggingface, TOKEN '${process.env.HF_TOKEN}')` : "CREATE SECRET (TYPE huggingface, PROVIDER credential_chain)");
mkdirSync(`${DATA_DIR}/audio`, { recursive: true });

const manifest: ClipMeta[] = [];
for (const j of jobs) {
  if (j.limit <= 0) continue;
  // No ORDER BY: preserve_insertion_order keeps file order, so LIMIT is deterministic and stops scanning early.
  const res = await con.runAndReadAll(
    `SELECT text, ${j.dur}::DOUBLE AS dur, audio.bytes AS bytes FROM read_parquet(${j.files})
     WHERE task_name = '${j.task}' AND regexp_matches(text, '${j.re}') LIMIT ${j.limit}`,
  );
  for (const r of res.getRowObjects()) {
    const bytes = Buffer.from((r.bytes as { bytes: Uint8Array }).bytes);
    const ext = bytes.subarray(0, 4).toString("latin1") === "RIFF" ? "wav" : bytes.subarray(0, 4).toString("latin1") === "fLaC" ? "flac" : "bin";
    // audio.path repeats across shards, so the id hashes the audio itself; identical clips are kept once.
    const id = `iv-${j.tag}-${createHash("sha1").update(bytes).digest("hex").slice(0, 8)}`;
    if (manifest.some((m) => m.id === id)) continue;
    const audioPath = `${DATA_DIR}/audio/${id}.${ext}`;
    writeFileSync(audioPath, bytes);
    manifest.push({ id, lang: j.lang, task: j.task, source: j.source, text: String(r.text), durationS: Number(r.dur), audioPath });
  }
  console.log(`${j.tag}: ${res.getRowObjects().length} clips`);
}
writeFileSync(`${DATA_DIR}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`wrote ${manifest.length} clips → ${DATA_DIR}/manifest.json`);
