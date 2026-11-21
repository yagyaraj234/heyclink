import { randomUUID } from "node:crypto";
import type { Cart, CartLine, GroceryLine, Household, Unit } from "../contracts.ts";
import catalogJson from "./catalog.json" with { type: "json" };

export interface CatalogEntry {
  name: string;
  unit: Unit;
  packSize: number; // in `unit`
  price: number; // INR per pack
  brands?: Record<string, number>; // brand id -> INR per pack
}

export const catalog = catalogJson as Record<string, CatalogEntry>;

// ponytail: mass and volume share one scale (density 1) so "ek kilo doodh" prices; fine for kitchen goods.
const SCALE: Partial<Record<Unit, [dim: string, factor: number]>> = {
  g: ["m", 1], kg: ["m", 1000], ml: ["m", 1], l: ["m", 1000],
  piece: ["n", 1], dozen: ["n", 12],
};

/** Packs needed. "packet" or a unit that doesn't convert counts qty as packs, except a weight or volume (no bunch weight to divide by). */
function packs(qty: number, unit: Unit, entry: CatalogEntry): number {
  const from = SCALE[unit];
  const to = SCALE[entry.unit];
  // ponytail: "150 g palak" of a per-bunch item = 1 bunch whatever the grams; add grams-per-pack to the catalog if big weights matter.
  if (from?.[0] === "m" && to?.[0] !== "m") return 1;
  if (unit === "packet" || !from || !to || from[0] !== to[0]) return Math.ceil(qty);
  return Math.ceil((qty * from[1]) / (entry.packSize * to[1]) - 1e-9);
}

export function searchUrl(name: string, brand?: string): string {
  // "Jeera (Cumin Seeds)" → "jeera": the bracketed English gloss only adds noise to a store search.
  const q = `${brand ? brand.replaceAll("-", " ") + " " : ""}${name.replace(/\s*\(.*?\)/g, "")}`.toLowerCase();
  return `https://www.swiggy.com/instamart/search?query=${encodeURIComponent(q)}`;
}

export interface ReviewedLine extends CartLine {
  pack: { count: number; size: number; unit: Unit };
  interpretation?: string;
}

export type RequestedLine = GroceryLine & { interpretation?: string };

export interface HeldLine {
  index: number;
  item: string;
  raw: string;
  reason: string;
  suggestion?: { qty: number; unit: Unit };
}

const grams = (qty: number, unit: Unit) => unit === "kg" ? qty * 1000 : unit === "g" ? qty : 0;

function packLimit(entry: CatalogEntry): number {
  const weight = grams(entry.packSize, entry.unit);
  if (weight) return Math.floor(2000 / weight);
  if (entry.unit === "piece") return Math.floor(12 / entry.packSize);
  if (entry.unit === "dozen") return 1;
  if (entry.unit === "l" || entry.unit === "ml") return Math.floor((entry.unit === "l" ? 2 : 2000) / entry.packSize);
  // Counted goods: up to three ordinary retail packs per item.
  return 3;
}

export function priceCart(lines: RequestedLine[], household: Pick<Household, "brands">, source: "cook" | "owner" = "cook") {
  const cartLines: ReviewedLine[] = [];
  const held: HeldLine[] = [];
  const used = new Map<string, { packs: number; grams: number }>();
  for (const [index, l] of lines.entries()) {
    const entry = Object.hasOwn(catalog, l.item) ? catalog[l.item] : undefined;
    const problem = { index, item: l.item, raw: l.raw };
    if (!entry || !Number.isFinite(l.qty) || l.qty <= 0) {
      held.push({ ...problem, reason: "Item or quantity needs clarification." });
      continue;
    }
    const corrected = source === "cook" && l.qty === 500 && l.unit === "kg" && grams(entry.packSize, entry.unit) > 0;
    const unit = corrected ? "g" : l.unit;
    const interpretation = corrected ? "Interpreted 500 kg as 500 g." : l.interpretation;
    const measured = SCALE[unit]?.[0] === "m";
    const converts = unit === "packet" || unit === entry.unit ||
      (SCALE[unit] && SCALE[unit]?.[0] === SCALE[entry.unit]?.[0]) ||
      (grams(l.qty, unit) > 0 && entry.unit === "bunch");
    const pieces = unit === "dozen" ? l.qty * 12 : l.qty;
    if (!converts || (!measured && !Number.isInteger(pieces))) {
      held.push({ ...problem, reason: `Check the pack size for ${entry.name}.`, suggestion: { qty: entry.packSize, unit: entry.unit } });
      continue;
    }
    const count = packs(l.qty, unit, entry);
    const prior = used.get(l.item) ?? { packs: 0, grams: 0 };
    const weight = grams(l.qty, unit);
    const available = packLimit(entry) - prior.packs;
    if (count > available || weight + prior.grams > 2000 || !Number.isSafeInteger(count) || count < 1) {
      const proposal = available > 0 ? { qty: entry.packSize, unit: entry.unit } : undefined;
      held.push({
        ...problem, reason: `${l.qty} ${unit} exceeds the household limit for ${entry.name}.`,
        ...(proposal && { suggestion: proposal }),
      });
      continue;
    }
    used.set(l.item, { packs: count + prior.packs, grams: weight + prior.grams });
    const brand = l.brand ?? household.brands[l.item];
    const price = count * ((brand && entry.brands && Object.hasOwn(entry.brands, brand) && entry.brands[brand]) || entry.price);
    cartLines.push({
      item: l.item, qty: l.qty, unit, ...(brand && { brand }), price, searchUrl: searchUrl(entry.name, brand),
      pack: { count, size: entry.packSize, unit: entry.unit }, ...(interpretation && { interpretation }),
    });
  }
  return { reviewId: randomUUID(), lines: cartLines, held, total: cartLines.reduce((s, l) => s + l.price, 0), platform: "mock" as const };
}

export const buildCart = async (lines: RequestedLine[], household: Household) => priceCart(lines, household);

export type ReviewedCart = ReturnType<typeof priceCart>;
export const reviewOf = (cart: Cart) => cart as Cart & Partial<Pick<ReviewedCart, "reviewId" | "held">>;

export const requestsFromCart = (cart: Cart): RequestedLine[] =>
  cart.lines.map(l => ({ ...l, raw: l.item, confidence: 1 }));

/** Sum one receipt in its first line's unit. An unknown conversion cannot establish how much was bought. */
export function purchasedQuantity(lines: Pick<GroceryLine, "qty" | "unit">[]) {
  const first = lines[0];
  if (!first) return;
  const baseUnits: Partial<Record<Unit, Unit>> = { kg: "g", l: "ml", dozen: "piece" };
  let qty = 0;
  for (const line of lines) {
    if ((baseUnits[line.unit] ?? line.unit) !== (baseUnits[first.unit] ?? first.unit) || !Number.isFinite(line.qty) || line.qty <= 0) return;
    qty += line.qty * (SCALE[line.unit]?.[1] ?? 1);
  }
  return { qty: qty / (SCALE[first.unit]?.[1] ?? 1), unit: first.unit };
}

/** Validate the stored quantities and prices again before approving or placing stored carts. */
export function matchesHouseholdBill(cart: Cart): boolean {
  const latest = priceCart(requestsFromCart(cart), { brands: {} });
  return !!latest.lines.length && !latest.held.length && latest.total === cart.total &&
    latest.lines.every((l, i) => l.qty === cart.lines[i]!.qty && l.unit === cart.lines[i]!.unit && l.price === cart.lines[i]!.price);
}
