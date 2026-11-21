import { randomUUID } from "node:crypto";
import type { ActionCard, Extraction, Household } from "../contracts.ts";
import { buildCart, catalog } from "./cart.ts";

const MIN_CONFIDENCE = 0.6;

export function upiUrl(upiId: string, name: string, amount: number, note: string): string {
  // pa stays raw: UPI apps expect a literal "@" in the VPA.
  return `upi://pay?pa=${upiId}&pn=${encodeURIComponent(name)}&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

/** Async because the cart comes from buildCart (a future Instamart backend is network-bound). */
export async function planActions(extraction: Extraction, household: Household): Promise<ActionCard[]> {
  const cards: ActionCard[] = [];
  const sure = extraction.groceries.filter((l) => l.confidence >= MIN_CONFIDENCE);
  const unsure = extraction.groceries.filter((l) => l.confidence < MIN_CONFIDENCE);
  if (sure.length) {
    const cart = await buildCart(sure, household);
    cards.push({ id: randomUUID(), type: "cart", cart, needsApproval: cart.total > household.approvalLimit });
  }
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
    const name = catalog[l.item]?.name ?? l.item;
    cards.push({
      id: randomUUID(),
      type: "question",
      text: `Did ${household.cook.name} mean ${l.qty} ${l.unit} ${name}? (heard: "${l.raw}")`,
      options: ["Yes, add it", "No, skip"],
    });
  }
  return cards;
}
