import { resolveItem } from "../indic/index.ts";
import { randomUUID } from "node:crypto";
import type { ActionCard, Extraction, GroceryLine, Household, Unit } from "../contracts.ts";
import type { HeldLine } from "./cart.ts";
import { priceCart, catalog } from "./cart.ts";

const MIN_CONFIDENCE = 0.6;
export const isUnsure = (l: GroceryLine) => l.confidence < MIN_CONFIDENCE;

// Shared with the pipeline (src/pipeline/process.ts imports these).
/** A word that fits several catalog items, e.g. "चना" → kabuli-chana | kala-chana. */
export type Ambiguous = { raw: string; qty: number; unit: Unit; candidates: string[] };
export type ExtractionWithAmbiguous = Extraction & { ambiguous?: Ambiguous[] };
/** One earlier call of this household, as processCall receives it in options.recent. */
export type RecentCall = { at: string; transcript: string; lines: Pick<GroceryLine, "item" | "qty" | "unit" | "brand">[] };

export const SKIP = "Skip";
export const itemName = (id: string) => catalog[id]?.name ?? id;

export function upiUrl(upiId: string, name: string, amount: number, note: string): string {
  // pa stays raw: UPI apps expect a literal "@" in the VPA.
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

type Question = Extract<ActionCard, { type: "question" }> & {
  prompt: { text: string; options: string[] };
};

export function groceryPlan(extraction: ExtractionWithAmbiguous, household: Household) {
  const sure = extraction.groceries.filter((l) => !isUnsure(l));
  const cart = priceCart(sure, household);
  const questions: { card: Question; choices: (GroceryLine | null)[]; heldIndex?: number }[] = [];
  const lang = household.cook.lang;
  const skip = lang === "hi" ? "छोड़ें" : lang === "te" ? "వద్దు" : SKIP;
  const yes = lang === "hi" ? "हाँ, जोड़ें" : lang === "te" ? "అవును, చేర్చండి" : "Yes, add it";
  const add = (text: string, options: string[], choices: (GroceryLine | null)[], localText: string,
    localOptions: string[], heldIndex?: number) => {
    questions.push({
      card: { id: randomUUID(), type: "question", text, options, prompt: { text: lang === "en" ? text : localText, options: lang === "en" ? options : localOptions } },
      choices, heldIndex,
    });
  };
  for (const l of extraction.groceries.filter(isUnsure)) {
    const text = `Did ${household.cook.name} mean ${l.qty} ${l.unit} ${itemName(l.item)}? (heard: "${l.raw}")`;
    const what = `${l.raw} · ${l.qty} ${l.unit}`;
    add(text, ["Yes, add it", "No, skip"], [l, null],
      lang === "te" ? `${what} కావాలా?` : `${what} चाहिए?`, [yes, skip]);
  }
  for (const a of extraction.ambiguous ?? []) {
    const options = a.candidates.map(itemName);
    add(`Which one did ${household.cook.name} mean by "${a.raw}"? (${a.qty} ${a.unit})`, [...options, SKIP],
      [...a.candidates.map(item => ({ raw: a.raw, qty: a.qty, unit: a.unit, item, confidence: 1 })), null],
      lang === "te" ? `“${a.raw}” అంటే ఏది?` : `“${a.raw}” से आपका मतलब कौन सा है?`, [...options, skip]);
  }
  for (const held of cart.held) questions.push(quantityQuestion(held, household, sure[held.index]?.brand));
  return { cart, questions };
}

export function quantityQuestion(held: HeldLine, household: Household, brand?: string) {
  const { suggestion, raw } = held;
  const amount = suggestion && `${suggestion.qty} ${suggestion.unit}`;
  const options = amount ? [`Add ${amount}`, SKIP] : [SKIP];
  const lang = household.cook.lang;
  const text = suggestion ? `${held.reason} Add one household pack instead?` : `${held.reason} Leave it out of this order.`;
  const prompt = lang === "te" ? { text: `“${raw}” పరిమాణం సరిచూడండి.`, options: amount ? [`${amount} చేర్చండి`, "వద్దు"] : ["వద్దు"] } :
    lang === "hi" ? { text: `“${raw}” की मात्रा जाँचें।`, options: amount ? [`${amount} जोड़ें`, "छोड़ें"] : ["छोड़ें"] } : { text, options };
  const card: Question = { id: randomUUID(), type: "question", text, options, prompt };
  const choices = suggestion ? [{ raw, item: held.item, ...suggestion, ...(brand && { brand }), confidence: 1 }, null] : [null];
  return { card, choices, heldIndex: held.index };

}

export async function planActions(extraction: ExtractionWithAmbiguous, household: Household): Promise<ActionCard[]> {
  const cards: ActionCard[] = [];
  const { cart, questions } = groceryPlan(extraction, household);
  if (cart.lines.length) cards.push({ id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit });
  if (extraction.advance) {
    const { name, upiId } = household.cook;
    cards.push({
      id: randomUUID(),
      type: "advance",
      advance: extraction.advance,
      payee: name,
      upiUrl: upiUrl(upiId, name, extraction.advance.amount, "Advance"),
      needsApproval: true,
    });
  }
  cards.push(...questions.map(q => q.card));
  return cards;
}

export function spokenOption(card: Extract<ActionCard, { type: "question" }>, choices: (GroceryLine | null)[], spoken: string) {
  const normalize = (s: string) => s.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{M}\p{N} ]/gu, "").trim();
  const text = normalize(spoken);
  const prompt = (card as Partial<Question>).prompt;
  const exact = card.options.find((option, i) => normalize(option) === text || (prompt && normalize(prompt.options[i]!) === text));
  if (exact) return exact;
  if (["हाँ", "हां", "haan", "yes", "అవును"].includes(text) && choices.length === 2 && choices[1] === null) return card.options[0];
  if (["नहीं", "नही", "no", "nahi", "వద్దు"].includes(text)) return card.options[choices.indexOf(null)];
  const ordinals = [["first", "पहला", "మొదటిది"], ["second", "दूसरा", "రెండవది"], ["third", "तीसरा", "మూడవది"]];
  const ordinal = ordinals.findIndex(words => words.includes(text));
  if (ordinal >= 0) return card.options[ordinal];
  const item = resolveItem(text);
  return item ? card.options[choices.findIndex(line => line?.item === item)] : undefined;
}
