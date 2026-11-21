import { randomUUID } from "node:crypto";
import type { CallInput, CallResult, GroceryLine, Household, Lang, Llm, Stt, Transcript } from "../contracts.ts";
import { UNITS } from "../contracts.ts";
import ITEMS from "../../fixtures/items.json" with { type: "json" };
import { normalizeQuantity, resolveBrand, resolveItem, STT_KEYWORDS } from "../indic/index.ts";
import { planActions } from "../actions/plan.ts";
import type { Ambiguous, ExtractionWithAmbiguous, RecentCall } from "../actions/plan.ts";
import { catalog } from "../actions/cart.ts";
import { openaiStt } from "./adapters/openai-stt.ts";
import { planMeals, weekday } from "./meals.ts";

/** Internal extension, like ExtractionWithAmbiguous: `cookOff` = the YYYY-MM-DD the cook says she won't come. */
export type PipelineExtraction = ExtractionWithAmbiguous & { cookOff?: string; stockouts?: string[]; neededBy?: string };

/** What the LLM returns. Richer than GroceryLine so the indic harness gets clean spans. */
interface LlmLine extends Omit<GroceryLine, "brand" | "item"> {
  requested?: boolean; // optional in code only: replies recorded before the field existed lack it
  itemWord: string;
  qtyPhrase: string;
  quantityOmitted?: boolean;
  stockout?: boolean;
  item: string | null; // null = not in our catalog, or ambiguous (then see candidates)
  candidates?: string[]; // optional in code only, like `requested`
  brand: string | null;
}
interface LlmExtraction {
  groceries: LlmLine[];
  advance: { amount: number; reason: string | null } | null;
  notes: string[];
  neededBy?: string | null;
  cookOff?: string | null; // optional in code only, like `requested`
}

const nullable = (type: string) => ({ type: [type, "null"] });

export const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["groceries", "advance", "notes", "cookOff", "neededBy"],
  properties: {
    groceries: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["raw", "requested", "stockout", "quantityOmitted", "itemWord", "qtyPhrase", "item", "candidates", "qty", "unit", "brand", "confidence"],
        properties: {
          raw: { type: "string", description: "span as heard, e.g. 'do kilo pyaaz'" },
          requested: {
            type: "boolean",
            description: "false only when the item is merely named while describing cooking steps (e.g. 'phir usmein nimbu daala'); true for any shopping mention: asking for it, saying it was/should be bought or ordered, past tense included (le aana, chahiye, mangaya, mangwana), or asking its price or availability",
          },
          itemWord: { type: "string", description: "the item word exactly as spoken, e.g. 'pyaaz'" },
          stockout: { type: "boolean", description: "The cook says this item has actually run out, e.g. pyaaz khatam ho gaya. A stockout implies a request to restock." },
          quantityOmitted: { type: "boolean", description: "True only if the cook gave no amount. A spoken but unclear amount is not omitted." },
          qtyPhrase: { type: "string", description: "the quantity words exactly as spoken, e.g. 'dedh kilo'" },
          item: { ...nullable("string"), enum: [...ITEMS, null], description: "catalog id; null if the product is not in the catalog. A product whose name merely contains a catalog word is not that item: 'cheez-pa potato chips', 'kaju katli', 'chocolate ice cream' → null; never split one product name into several lines" },
          candidates: {
            type: "array",
            items: { type: "string", enum: ITEMS },
            description: "only for a bare generic word that several catalog ids share (चना → kabuli-chana, kala-chana; daal → toor-dal, moong-dal, masoor-dal): list 2-4 of them and leave item null. Otherwise []: anything that fits one catalog id, even loosely or under a brand, still gets that id in item",
          },
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
    neededBy: { ...nullable("string"), description: "Only if the cook gives a grocery deadline: ISO 8601 local time in India with +05:30. For dinner without a stated hour use 18:00 on the requested date. Otherwise null." },
    cookOff: { ...nullable("string"), description: "YYYY-MM-DD the cook won't come, said or asked for ('kal nahi aaungi', 'Sunday chutti', 'Sunday chutti chahiye', 'parso chhutti lungi'): the next such day counted from Today; null if she doesn't mention a day off" },
  },
} as const;

const SYSTEM = `You turn a household cook's voice note (English, Hindi, Hinglish or Telugu) into a grocery order for their employer.
- One grocery line per item requested. "item" must be one of the allowed ids.
- qty/unit: the spoken quantity as a number and unit. Never 0: for a vague amount ("thoda", "thoda sa", "kuch") use one usual pack or bunch.
- brand: only when said, or when the cook means the usual one ("wahi wala", "same as last time", "jo hamesha aata hai") — then use the household's preferred brand for that item. Otherwise null.
- confidence: 0..1, how sure you are of item AND quantity. Below 0.6 when either is a guess (vague "thoda", "woh wala" with no known preference, garbled words); the employer is then asked to confirm.
- advance: money the cook asks for themselves (salary advance), in INR. null if none.
- notes: anything else worth telling the employer that is not a purchase, verbatim and short (e.g. "kal 8 baje aaungi"). Report a household stockout as a grocery request even without an explicit request to buy. Keep meal questions in notes so the household can answer.`;

const HARNESS_RULES = "\n- Quantity words: paav=0.25, aadha=0.5, dedh=1.5, dhai=2.5, saade X=X+0.5; gaddi=bunch, darjan=dozen." +
  "\n- item is the generic product, never null for a branded catalog item: Tata Tea→tea, Surf Excel→detergent-powder, Vim bar→dishwash-bar, Amul doodh→milk; brand is the brand alone (tata, surf-excel, vim, amul)." +
  "\n- Spelling variants are one id: kishmish/kismis/किशमिश/किसमिस→raisins." +
  "\n- References to earlier notes or orders ('wahi jo subah bola tha', 'woh daal', 'same as last time', 'aur ek') resolve from recentNotes (the household's latest voice notes, oldest to newest) and recentOrders: use that item, and its brand and quantity unless new ones are said.";

function householdContext(h: Household, recent: RecentCall[]) {
  return JSON.stringify({ preferredBrands: h.brands, pantry: h.pantry, recentOrders: h.history, recentNotes: recent, dietRules: h.family.dietRules });
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

function toLine(l: LlmLine, harness: boolean, known: Set<string>): GroceryLine | Ambiguous | undefined {
  if (l.requested === false) return;
  // a known brand in front means the tail is the item; otherwise trust the LLM before guessing from a tail
  const branded = harness && spokenBrand(l.itemWord) !== undefined;
  let item = harness
    ? (resolveItem(l.itemWord) ?? (branded ? resolveTail(l.itemWord) : null) ?? l.item ?? resolveTail(l.itemWord) ?? resolveTail(l.raw))
    : l.item;
  const q = harness ? normalizeQuantity(l.qtyPhrase) : null;
  let guess = false;
  if (!item || !(ITEMS as string[]).includes(item)) {
    // ambiguous word ("चना"): the one candidate this household already buys settles it, otherwise ask
    const candidates = [...new Set(l.candidates ?? [])].filter((c) => (ITEMS as string[]).includes(c));
    const seen = candidates.filter((c) => known.has(c));
    if (seen.length !== 1 && candidates.length === 1) {
      // one option: take it, but low confidence makes planActions ask "did they mean…?"
      seen.push(candidates[0]!);
      guess = true;
    }
    if (seen.length !== 1) {
      if (!candidates.length) return; // unknown product: dropped
      const qty = q?.qty ?? l.qty;
      // raw = the spoken word alone ("chana"): the question card quotes it
      const raw = l.itemWord.trim() || l.raw;
      return qty > 0 ? { raw, qty, unit: q?.unit ?? l.unit, candidates } : { raw, qty: 1, unit: "packet", candidates };
    }
    item = seen[0]!;
  }
  // the spoken word beats the LLM's transliteration of it (हैंको vs "hanco"); the LLM's slug is matched whole,
  // never cut to a brand word inside it ("tata-sampann" stays, not tata)
  const brand = harness ? (spokenBrand(l.itemWord) ?? (l.brand ? (resolveBrand(l.brand) ?? l.brand) : undefined)) : l.brand;
  const line: GroceryLine = {
    raw: l.raw,
    item,
    qty: q?.qty ?? l.qty,
    unit: q?.unit ?? l.unit,
    confidence: guess ? Math.min(l.confidence, 0.5) : l.confidence,
  };
  if (!(line.qty > 0)) {
    // vague amount ("thoda sa palak") came back as 0: offer one pack and ask (planActions asks below 0.6)
    const pack = catalog[item];
    line.qty = pack?.packSize ?? 1;
    line.unit = pack?.unit ?? "packet";
    line.confidence = Math.min(line.confidence, 0.5);
  }
  if (brand) line.brand = brand.trim().toLowerCase().replace(/\s+/g, "-");
  return line;
}

/** harness: false = eval baseline (plain LLM: no household context, no STT keywords, no indic pass). */
export interface PipelineOptions {
  harness?: boolean;
  recent?: RecentCall[]; // the household's last calls (≤5), oldest to newest; harness only
  now?: Date; // resolves "kal"/"Sunday"; tests pin it
}

const IST = "Asia/Kolkata";

export async function processTranscript(text: string, lang: Lang, household: Household, ports: { llm: Llm }, { harness = true, recent = [], now = new Date() }: PipelineOptions = {}): Promise<PipelineExtraction> {
  const today = `${now.toLocaleDateString("en-CA", { timeZone: IST })} (${now.toLocaleDateString("en-US", { timeZone: IST, weekday: "long" })})`;
  const context = harness ? `Household: ${householdContext(household, recent)}\n` : "";
  const known = new Set(harness ? [...household.history, ...recent].flatMap((o) => o.lines.map((l) => l.item)) : []);
  const out = await ports.llm.json<LlmExtraction>({
    system: harness ? SYSTEM + HARNESS_RULES : SYSTEM,
    user: `${context}Today: ${today}\nLanguage hint: ${lang}\nVoice note: ${text}`,
    schema: EXTRACTION_SCHEMA,
    schemaName: "extraction",
  });
  const stockouts = new Set<string>();
  const lines = out.groceries.map((source) => {
    const line = toLine(source, harness, known);
    if (!line || "candidates" in line) return line;
    if (source.stockout) stockouts.add(line.item);
    if (!harness || !source.quantityOmitted || source.qtyPhrase.trim()) return line;
    const previous = household.history.flatMap(order => order.lines).findLast(bought => bought.item === line.item);
    if (previous && previous.qty > 0 &&
        !(previous.unit === "kg" && previous.qty > 2) && !(previous.unit === "g" && previous.qty > 2000)) {
      return { ...line, qty: previous.qty, unit: previous.unit, interpretation: "Quantity unspecified. Suggested the last household purchase." };
    }
    const pack = catalog[line.item];
    if (!pack) return line;
    return { ...line, qty: pack.packSize, unit: pack.unit, interpretation: "Quantity unspecified. Suggested one catalog pack." };
  });
  const extraction: PipelineExtraction = {
    groceries: lines.filter((l): l is GroceryLine => l !== undefined && !("candidates" in l)),
    notes: out.notes,
  };
  if (out.neededBy && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(Z|[+-]\d{2}:\d{2})$/.test(out.neededBy)) {
    const deadline = Date.parse(out.neededBy);
    if (deadline > now.getTime()) extraction.neededBy = new Date(deadline).toISOString();
  }
  if (stockouts.size) extraction.stockouts = [...stockouts];
  const ambiguous = lines.filter((l): l is Ambiguous => l !== undefined && "candidates" in l);
  if (ambiguous.length) extraction.ambiguous = ambiguous;
  // trust boundary: planMeals needs a real calendar date
  if (out.cookOff && /^\d{4}-\d{2}-\d{2}$/.test(out.cookOff) && !Number.isNaN(Date.parse(out.cookOff))) extraction.cookOff = out.cookOff;
  if (out.advance) {
    extraction.advance = { amount: out.advance.amount };
    if (out.advance.reason) extraction.advance.reason = out.advance.reason;
  }
  return extraction;
}

/** The cook said she's off on `date`: plan as if it were one of her off days. */
function offOn(h: Household, date: string): Household {
  return { ...h, cook: { ...h.cook, offDays: [...new Set([...(h.cook.offDays ?? []), weekday(date)])] } };
}

// Sarvam's sync API rejects audio over 30 s ("use the batch API"); cook notes can run longer.
const TOO_LONG = /maximum limit of 30 seconds|batch API/i;

/** fallbackStt: used only when `stt` hits Sarvam's length limit; defaults to OpenAI. */
export async function processCall(input: CallInput, household: Household, ports: { stt: Stt; llm: Llm; fallbackStt?: Stt }, options: PipelineOptions = {}): Promise<CallResult & { extraction: PipelineExtraction }> {
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
  const [actions, mealPlan] = await Promise.all([
    planActions(extraction, household),
    // a failed meal plan must not cost the grocery cart
    extraction.cookOff ? planMeals(offOn(household, extraction.cookOff), extraction.cookOff, ports).catch((e: unknown) => void console.warn("planMeals failed:", e)) : undefined,
  ]);
  if (mealPlan) actions.push({ id: randomUUID(), type: "meal-plan", plan: mealPlan, options: ["cook", "order"] });
  const t3 = performance.now();
  return {
    callId: randomUUID(),
    transcript,
    extraction,
    actions,
    timings: { sttMs: t1 - t0, extractMs: t2 - t1, planMs: t3 - t2, totalMs: t3 - t0 },
  };
}
