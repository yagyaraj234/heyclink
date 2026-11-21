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

/** Mock backend. An Instamart MCP backend slots in behind this same signature (see docs/instamart.md). */
export async function buildCart(lines: GroceryLine[], household: Household): Promise<Cart> {
  const cartLines = lines.map((l): CartLine => {
    const brand = l.brand ?? household.brands[l.item];
    const entry = catalog[l.item];
    // ponytail: unknown item ids price at 0 and still get a search link; ids are canonical so this is the LLM-junk path.
    const price = entry ? packs(l.qty, l.unit, entry) * ((brand && entry.brands?.[brand]) || entry.price) : 0;
    return { item: l.item, qty: l.qty, unit: l.unit, ...(brand && { brand }), price, searchUrl: searchUrl(entry?.name ?? l.item, brand) };
  });
  return { lines: cartLines, total: cartLines.reduce((s, l) => s + l.price, 0), platform: "mock" };
}
