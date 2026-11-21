import { randomUUID } from "node:crypto";
import type { CallInput, CallResult, Extraction, GroceryLine, Household, Lang, Llm, Stt, Transcript } from "../contracts.ts";
import { UNITS } from "../contracts.ts";
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { normalizeQuantity, resolveBrand, resolveItem, STT_KEYWORDS } from "../indic/index.ts";
import { planActions } from "../actions/plan.ts";
import { catalog } from "../actions/cart.ts";
import { openaiStt } from "./adapters/openai-stt.ts";

/** What the LLM returns. Richer than GroceryLine so the indic harness gets clean spans. */
interface LlmLine extends Omit<GroceryLine, "brand" | "item"> {
  requested?: boolean; // optional in code only: replies recorded before the field existed lack it
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
        required: ["raw", "requested", "itemWord", "qtyPhrase", "item", "qty", "unit", "brand", "confidence"],
        properties: {
          raw: { type: "string", description: "span as heard, e.g. 'do kilo pyaaz'" },
          requested: {
            type: "boolean",
            description: "false only when the item is merely named while describing cooking steps (e.g. 'phir usmein nimbu daala'); true for any shopping mention: asking for it, saying it was/should be bought or ordered, past tense included (le aana, chahiye, mangaya, mangwana), or asking its price or availability",
          },
          itemWord: { type: "string", description: "the item word exactly as spoken, e.g. 'pyaaz'" },
          qtyPhrase: { type: "string", description: "the quantity words exactly as spoken, e.g. 'dedh kilo'" },
          item: { ...nullable("string"), enum: [...ITEMS, null], description: "catalog id; null if the product is not in the catalog. A product whose name merely contains a catalog word is not that item: 'cheez-pa potato chips', 'kaju katli', 'chocolate ice cream' → null; never split one product name into several lines" },
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
- qty/unit: the spoken quantity as a number and unit. Never 0: for a vague amount ("thoda", "thoda sa", "kuch") use one usual pack or bunch.
- brand: only when said, or when the cook means the usual one ("wahi wala", "same as last time", "jo hamesha aata hai") — then use the household's preferred brand for that item. Otherwise null.
- confidence: 0..1, how sure you are of item AND quantity. Below 0.6 when either is a guess (vague "thoda", "woh wala" with no known preference, garbled words); the employer is then asked to confirm.
- advance: money the cook asks for themselves (salary advance), in INR. null if none.
- notes: anything else worth telling the employer that is not a purchase, verbatim and short (e.g. "kal 8 baje aaungi"). Mentions that something is running low without asking to buy it go in notes, not groceries.`;

const HARNESS_RULES = "\n- Quantity words: paav=0.25, aadha=0.5, dedh=1.5, dhai=2.5, saade X=X+0.5; gaddi=bunch, darjan=dozen." +
  "\n- item is the generic product, never null for a branded catalog item: Tata Tea→tea, Surf Excel→detergent-powder, Vim bar→dishwash-bar, Amul doodh→milk; brand is the brand alone (tata, surf-excel, vim, amul)." +
  "\n- Spelling variants are one id: kishmish/kismis/किशमिश/किसमिस→raisins.";

function householdContext(h: Household) {
  return JSON.stringify({ preferredBrands: h.brands, pantry: h.pantry, recentOrders: h.history, dietRules: h.family.dietRules });
}

export function sttKeywords(h: Household): string[] {
  const items = [...Object.keys(h.brands), ...Object.keys(h.pantry), ...h.history.flatMap((o) => o.lines.map((l) => l.item))];
  // household terms first: Sarvam keeps only the first 50 keyterms
  return [...new Set([...[...Object.values(h.brands), ...items].map((w) => w.replaceAll("-", " ")), ...STT_KEYWORDS])];
}

/** First brand named anywhere in `text` ("हैंको डिटर्जेंट बार" → henko): longest word span first, so "india gate" beats "gate". */
function spokenBrand(text: string): string | undefined {
  const w = text.split(/[^\p{L}\p{M}\p{N}\u200c\u200d]+/u).filter(Boolean); // "vim-bar" → vim, bar
  for (let n = w.length; n > 0; n--)
    for (let i = 0; i + n <= w.length; i++) {
      const id = resolveBrand(w.slice(i, i + n).join(" "));
      if (id) return id;
    }
  return undefined;
}

/**
 * "Tata Tea" → tea, "Amul doodh" → milk: Hindi/Telugu noun phrases end in the item, so try ever-shorter tails,
 * each also with its spaces removed: STT splits compounds (కరివేపాకు heard as "కర్వే పాకు").
 */
function resolveTail(phrase: string): string | null {
  const w = phrase.trim().split(/\s+/);
  for (let i = 0; i < w.length; i++) {
    const id = resolveItem(w.slice(i).join(" ")) ?? resolveItem(w.slice(i).join(""));
    if (id) return id;
  }
  return null;
}

function toLine(l: LlmLine, harness: boolean): GroceryLine[] {
  if (l.requested === false) return [];
  // a known brand in front means the tail is the item; otherwise trust the LLM before guessing from a tail
  const branded = harness && spokenBrand(l.itemWord) !== undefined;
  const item = harness
    ? (resolveItem(l.itemWord) ?? (branded ? resolveTail(l.itemWord) : null) ?? l.item ?? resolveTail(l.itemWord) ?? resolveTail(l.raw))
    : l.item;
  if (!item || !(ITEMS as string[]).includes(item)) return [];
  // the spoken word beats the LLM's transliteration of it (हैंको vs "hanco")
  const brand = harness ? (spokenBrand(l.itemWord) ?? (l.brand ? (spokenBrand(l.brand) ?? l.brand) : undefined)) : l.brand;
  const q = harness ? normalizeQuantity(l.qtyPhrase) : null;
  const line: GroceryLine = {
    raw: l.raw,
    item,
    qty: q?.qty ?? l.qty,
    unit: q?.unit ?? l.unit,
    confidence: l.confidence,
  };
  if (!(line.qty > 0)) {
    // vague amount ("thoda sa palak") came back as 0: offer one pack and ask (planActions asks below 0.6)
    const pack = catalog[item];
    line.qty = pack?.packSize ?? 1;
    line.unit = pack?.unit ?? "packet";
    line.confidence = Math.min(line.confidence, 0.5);
  }
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

// Sarvam's sync API rejects audio over 30 s ("use the batch API"); cook notes can run longer.
const TOO_LONG = /maximum limit of 30 seconds|batch API/i;

/** fallbackStt: used only when `stt` hits Sarvam's length limit; defaults to OpenAI. */
export async function processCall(input: CallInput, household: Household, ports: { stt: Stt; llm: Llm; fallbackStt?: Stt }, options: PipelineOptions = {}): Promise<CallResult> {
  const t0 = performance.now();
  const opts: { lang?: Lang; keywords: string[] } = { keywords: options.harness === false ? [] : sttKeywords(household) };
  if (input.lang) opts.lang = input.lang;
  const transcript: Transcript = await ports.stt.transcribe(input.audioPath, opts).catch((e: unknown) => {
    if (!(e instanceof Error && TOO_LONG.test(e.message))) throw e;
    return (ports.fallbackStt ?? openaiStt()).transcribe(input.audioPath, opts);
  });
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
