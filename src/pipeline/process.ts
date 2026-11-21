import { randomUUID } from "node:crypto";
import type { CallInput, CallResult, Extraction, GroceryLine, Household, Lang, Llm, Stt, Transcript } from "../contracts.ts";
import { UNITS } from "../contracts.ts";
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { normalizeQuantity, resolveItem } from "./indic-stub.ts";

/** What the LLM returns. Richer than GroceryLine so the indic harness gets clean spans. */
interface LlmLine extends Omit<GroceryLine, "brand"> {
  itemWord: string;
  qtyPhrase: string;
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
          item: { type: "string", enum: ITEMS },
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
- qty/unit: convert spoken quantities (paav=0.25, aadha=0.5, dedh=1.5, dhai=2.5, saade X=X+0.5; gaddi=bunch, darjan=dozen).
- brand: only when said, or when the cook means the usual one ("wahi wala", "same as last time", "jo hamesha aata hai") — then use the household's preferred brand for that item. Otherwise null.
- advance: money the cook asks for themselves (salary advance), in INR. null if none.
- notes: anything else worth telling the employer that is not a purchase, verbatim and short (e.g. "kal 8 baje aaungi"). Mentions that something is running low without asking to buy it go in notes, not groceries.`;

function householdContext(h: Household) {
  return JSON.stringify({ preferredBrands: h.brands, pantry: h.pantry, recentOrders: h.history, dietRules: h.family.dietRules });
}

export function sttKeywords(h: Household): string[] {
  const items = [...Object.keys(h.brands), ...Object.keys(h.pantry), ...h.history.flatMap((o) => o.lines.map((l) => l.item))];
  return [...new Set([...Object.values(h.brands), ...items].map((w) => w.replaceAll("-", " ")))];
}

function toLine(l: LlmLine): GroceryLine {
  const q = normalizeQuantity(l.qtyPhrase);
  const line: GroceryLine = {
    raw: l.raw,
    item: resolveItem(l.itemWord) ?? l.item,
    qty: q?.qty ?? l.qty,
    unit: q?.unit ?? l.unit,
    confidence: l.confidence,
  };
  if (l.brand) line.brand = l.brand;
  return line;
}

export async function processTranscript(text: string, lang: Lang, household: Household, ports: { llm: Llm }): Promise<Extraction> {
  const out = await ports.llm.json<LlmExtraction>({
    system: SYSTEM,
    user: `Household: ${householdContext(household)}\nLanguage hint: ${lang}\nVoice note: ${text}`,
    schema: EXTRACTION_SCHEMA,
    schemaName: "extraction",
  });
  const extraction: Extraction = {
    groceries: out.groceries.map(toLine).filter((l) => (ITEMS as string[]).includes(l.item)),
    notes: out.notes,
  };
  if (out.advance) {
    extraction.advance = { amount: out.advance.amount };
    if (out.advance.reason) extraction.advance.reason = out.advance.reason;
  }
  return extraction;
}

export async function processCall(input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }): Promise<CallResult> {
  const t0 = performance.now();
  const opts: { lang?: Lang; keywords: string[] } = { keywords: sttKeywords(household) };
  if (input.lang) opts.lang = input.lang;
  const transcript: Transcript = await ports.stt.transcribe(input.audioPath, opts);
  const t1 = performance.now();
  const extraction = await processTranscript(transcript.text, transcript.lang, household, ports);
  const t2 = performance.now();
  const actions: CallResult["actions"] = []; // lane 2 wires planActions here
  const t3 = performance.now();
  return {
    callId: randomUUID(),
    transcript,
    extraction,
    actions,
    timings: { sttMs: t1 - t0, extractMs: t2 - t1, planMs: t3 - t2, totalMs: t3 - t0 },
  };
}
