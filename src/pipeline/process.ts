import { randomUUID } from "node:crypto";
import type { CallInput, CallResult, Extraction, GroceryLine, Household, Lang, Llm, Stt, Transcript } from "../contracts.ts";
import { UNITS } from "../contracts.ts";
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { normalizeQuantity, resolveItem, STT_KEYWORDS } from "../indic/index.ts";
import { planActions } from "../actions/plan.ts";

/** What the LLM returns. Richer than GroceryLine so the indic harness gets clean spans. */
interface LlmLine extends Omit<GroceryLine, "brand" | "item"> {
  itemWord: string;
  qtyPhrase: string;
  item: string | null; // null = not in our catalog
  brand: string | null;
}
interface LlmExtraction {
  groceries: LlmLine[];
  advance: { amount: number; reason: string | null } | null;
  notes: string[];
}

const nullable = (type: string) => ({ type: [type, "null"] });

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groceries", "advance", "notes"],
  properties: {
    groceries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["raw", "itemWord", "qtyPhrase", "item", "qty", "unit", "brand", "confidence"],
        properties: {
          raw: { type: "string", description: "span as heard, e.g. 'do kilo pyaaz'" },
          itemWord: { type: "string", description: "the item word exactly as spoken, e.g. 'pyaaz'" },
          qtyPhrase: { type: "string", description: "the quantity words exactly as spoken, e.g. 'dedh kilo'" },
          item: { ...nullable("string"), enum: [...ITEMS, null], description: "catalog id; null if the item is not in the catalog" },
          qty: { type: "number" },
          unit: { type: "string", enum: UNITS },
          brand: { ...nullable("string"), description: "lowercase kebab-case brand id, e.g. 'aashirvaad', 'india-gate'" },
          confidence: { type: "number" },
        },
      },
    },
    advance: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["amount", "reason"],
          properties: { amount: { type: "number", description: "INR" }, reason: nullable("string") },
        },
        { type: "null" },
      ],
    },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

const SYSTEM = `You turn a household cook's voice note (Hindi, Hinglish or Telugu) into a grocery order for their employer.
- One grocery line per item requested. "item" must be one of the allowed ids.
- qty/unit: the spoken quantity as a number and unit.
- brand: only when said, or when the cook means the usual one ("wahi wala", "same as last time", "jo hamesha aata hai") — then use the household's preferred brand for that item. Otherwise null.
- confidence: 0..1, how sure you are of item AND quantity. Below 0.6 when either is a guess (vague "thoda", "woh wala" with no known preference, garbled words); the employer is then asked to confirm.
- advance: money the cook asks for themselves (salary advance), in INR. null if none.
- notes: anything else worth telling the employer that is not a purchase, verbatim and short (e.g. "kal 8 baje aaungi"). Mentions that something is running low without asking to buy it go in notes, not groceries.`;

const HARNESS_RULES = "\n- Quantity words: paav=0.25, aadha=0.5, dedh=1.5, dhai=2.5, saade X=X+0.5; gaddi=bunch, darjan=dozen.";

function householdContext(h: Household) {
  return JSON.stringify({ preferredBrands: h.brands, pantry: h.pantry, recentOrders: h.history, dietRules: h.family.dietRules });
}

export function sttKeywords(h: Household): string[] {
  const items = [...Object.keys(h.brands), ...Object.keys(h.pantry), ...h.history.flatMap((o) => o.lines.map((l) => l.item))];
  // household terms first: Sarvam keeps only the first 50 keyterms
  return [...new Set([...[...Object.values(h.brands), ...items].map((w) => w.replaceAll("-", " ")), ...STT_KEYWORDS])];
}

// spoken brand word → brand id (ids from eval/recording-script.md).
// ponytail: closed list, grow it from eval misses; a brand not listed passes through as the LLM's slug.
const BRANDS: Record<string, string> = {
  aashirvaad: "aashirvaad", amul: "amul", britannia: "britannia", fortune: "fortune", "india gate": "india-gate",
  surf: "surf-excel", tata: "tata", vim: "vim",
  आशीर्वाद: "aashirvaad", अमूल: "amul", ब्रिटानिया: "britannia", फॉर्च्यून: "fortune", "इंडिया गेट": "india-gate",
  सर्फ: "surf-excel", टाटा: "tata", विम: "vim",
};

function spokenBrand(text: string): string | undefined {
  const t = ` ${text.normalize().toLowerCase().replace(/़/g, "").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim()} `;
  return Object.entries(BRANDS).find(([w]) => t.includes(` ${w} `))?.[1];
}

/** "Tata Tea" → tea, "Amul doodh" → milk: Hindi noun phrases end in the item, so try ever-shorter tails. */
function resolveTail(itemWord: string): string | null {
  const w = itemWord.trim().split(/\s+/);
  for (let i = 1; i < w.length; i++) {
    const id = resolveItem(w.slice(i).join(" "));
    if (id) return id;
  }
  return null;
}

function toLine(l: LlmLine, harness: boolean): GroceryLine[] {
  const item = harness ? (resolveItem(l.itemWord) ?? l.item ?? resolveTail(l.itemWord)) : l.item;
  if (!item || !(ITEMS as string[]).includes(item)) return [];
  const brand = harness ? (l.brand ? (spokenBrand(l.brand) ?? l.brand) : spokenBrand(l.itemWord)) : l.brand;
  const q = harness ? normalizeQuantity(l.qtyPhrase) : null;
  const line: GroceryLine = {
    raw: l.raw,
    item,
    qty: q?.qty ?? l.qty,
    unit: q?.unit ?? l.unit,
    confidence: l.confidence,
  };
  if (brand) line.brand = brand.trim().toLowerCase().replace(/\s+/g, "-");
  return [line];
}

/** harness: false = eval baseline (plain LLM: no household context, no STT keywords, no indic pass). */
export interface PipelineOptions {
  harness?: boolean;
}

export async function processTranscript(text: string, lang: Lang, household: Household, ports: { llm: Llm }, { harness = true }: PipelineOptions = {}): Promise<Extraction> {
  const context = harness ? `Household: ${householdContext(household)}\n` : "";
  const out = await ports.llm.json<LlmExtraction>({
    system: harness ? SYSTEM + HARNESS_RULES : SYSTEM,
    user: `${context}Language hint: ${lang}\nVoice note: ${text}`,
    schema: EXTRACTION_SCHEMA,
    schemaName: "extraction",
  });
  const extraction: Extraction = {
    groceries: out.groceries.flatMap((l) => toLine(l, harness)),
    notes: out.notes,
  };
  if (out.advance) {
    extraction.advance = { amount: out.advance.amount };
    if (out.advance.reason) extraction.advance.reason = out.advance.reason;
  }
  return extraction;
}

export async function processCall(input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }, options: PipelineOptions = {}): Promise<CallResult> {
  const t0 = performance.now();
  const opts: { lang?: Lang; keywords: string[] } = { keywords: options.harness === false ? [] : sttKeywords(household) };
  if (input.lang) opts.lang = input.lang;
  const transcript: Transcript = await ports.stt.transcribe(input.audioPath, opts);
  const t1 = performance.now();
  const extraction = await processTranscript(transcript.text, transcript.lang, household, ports, options);
  const t2 = performance.now();
  // question cards follow unsure-line order in `extraction`; POST /actions/:id/answer relies on it
  const actions = await planActions(extraction, household);
  const t3 = performance.now();
  return {
    callId: randomUUID(),
    transcript,
    extraction,
    actions,
    timings: { sttMs: t1 - t0, extractMs: t2 - t1, planMs: t3 - t2, totalMs: t3 - t0 },
  };
}
