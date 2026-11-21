import { randomUUID } from "node:crypto";
import type { ActionCard, Extraction, GroceryLine, Household, Unit } from "../contracts.ts";
import { buildCart, catalog } from "./cart.ts";

const MIN_CONFIDENCE = 0.6;
export const isUnsure = (l: GroceryLine) => l.confidence < MIN_CONFIDENCE;

// ponytail: local stubs for lane 1's pending PR (extraction.ambiguous, options.recent); import theirs once it lands.
/** A word that fits several catalog items, e.g. "चना" → kabuli-chana | kala-chana. */
export type Ambiguous = { raw: string; qty: number; unit: Unit; candidates: string[] };
export type ExtractionWithAmbiguous = Extraction & { ambiguous?: Ambiguous[] };
/** One earlier call of this household, as processCall receives it in options.recent. */
export type RecentCall = { at: string; transcript: string; lines: Pick<GroceryLine, "item" | "qty" | "unit" | "brand">[] };

export const SKIP = "Skip";
export const itemName = (id: string) => catalog[id]?.name ?? id;

export type CartCard = Extract<ActionCard, { type: "cart" }>;

export async function cartCard(lines: GroceryLine[], household: Household): Promise<CartCard> {
  const cart = await buildCart(lines, household);
  return { id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit };
}

export function upiUrl(upiId: string, name: string, amount: number, note: string): string {
  // pa stays raw: UPI apps expect a literal "@" in the VPA.
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

/** Async because the cart comes from buildCart (a future Instamart backend is network-bound). */
export async function planActions(extraction: ExtractionWithAmbiguous, household: Household): Promise<ActionCard[]> {
  const cards: ActionCard[] = [];
  const sure = extraction.groceries.filter((l) => !isUnsure(l));
  const unsure = extraction.groceries.filter(isUnsure);
  if (sure.length) cards.push(await cartCard(sure, household));
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
  for (const l of unsure) {
    cards.push({
      id: randomUUID(),
      type: "question",
      text: `Did ${household.cook.name} mean ${l.qty} ${l.unit} ${itemName(l.item)}? (heard: "${l.raw}")`,
      options: ["Yes, add it", "No, skip"],
    });
  }
  // after the unsure-line questions; POST /actions/:id/answer relies on this order
  for (const a of extraction.ambiguous ?? []) {
    cards.push({
      id: randomUUID(),
      type: "question",
      text: `Which one did ${household.cook.name} mean by "${a.raw}"? (${a.qty} ${a.unit})`,
      options: [...a.candidates.map(itemName), SKIP],
    });
  }
  return cards;
}
