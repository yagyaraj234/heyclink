// Draft gold for IndicVoices clips.
//   node --env-file-if-exists=.env eval/prelabel.ts          → drafts in eval/data/indicvoices/drafts/ (gitignored)
// Review them with eval/review.ts. Drafts come from our own harness, so they bias the reviewer toward it. Read the transcript, not the draft.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { Household } from "../src/contracts.ts";
import { IV_DIR as DATA_DIR, readJson as read, type Case, type ClipMeta } from "./dataset.ts";
import { openaiLlm, processTranscript } from "./pipeline.ts";

const DRAFTS = `${DATA_DIR}/drafts`;

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

await draft();
