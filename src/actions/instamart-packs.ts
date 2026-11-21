import type { CartLine } from "../contracts.ts";
import { catalog } from "./cart.ts";
import type { CartItem, Variation } from "./instamart-client.ts";

type Size = { unit: "g" | "ml" | "piece" | "pack"; amount: number };
const limits = { g: 2000, ml: 2000, piece: 12, pack: 3 };
const units: Record<string, [Size["unit"], number]> = {
  g: ["g", 1],
  gm: ["g", 1],
  grams: ["g", 1],
  gram: ["g", 1],
  kg: ["g", 1000],
  ml: ["ml", 1],
  l: ["ml", 1000],
  litre: ["ml", 1000],
  liter: ["ml", 1000],
  piece: ["piece", 1],
  pieces: ["piece", 1],
  pcs: ["piece", 1],
  pc: ["piece", 1],
  dozen: ["piece", 12],
  bunch: ["pack", 1],
  bunches: ["pack", 1],
  packet: ["pack", 1],
  pack: ["pack", 1],
};
function size(qty: number, unit: string): Size | undefined {
  const scale = units[unit];
  if (scale && Number.isFinite(qty) && qty > 0) return { unit: scale[0], amount: qty * scale[1] };
}
function parsePack(value?: string) {
  const m = /^(\d+(?:\.\d+)?)\s*([a-z]+)$/i.exec(value?.trim() ?? "");
  return m ? size(Number(m[1]), m[2]!.toLowerCase()) : undefined;
}
const words = (value: string) =>
  value
    .toLowerCase()
    .replace(/[-_()]/g, " ")
    .replace(/[^a-z0-9 ]/g, "")
    .trim()
    .split(/\s+/);
export function sameGrocery(item: string, name: string, brand = ""): boolean {
  const catalogName = catalog[item]?.name ?? item;
  const aliases = [item, ...catalogName.split(/[()]/)].filter(Boolean);
  const descriptors = new Set([
    ...words(brand),
    "fresh",
    "organic",
    "local",
    "loose",
    "premium",
    "small",
    "medium",
    "large",
    "big",
    "red",
    "green",
    "whole",
  ]);
  const title = words(name);
  return aliases.some((alias) => {
    const terms = words(alias);
    return (
      terms.every((term) => title.some((t) => t === term || t === term + "s")) &&
      title.every((t) => terms.some((term) => t === term || t === term + "s") || descriptors.has(t))
    );
  });
}
export type PickedPack = { variant: Variation; count: number; size: Size; item: string };
export function packOption(line: CartLine, variant: Variation): PickedPack | undefined {
  const physical = parsePack(variant.quantityDescription);
  const requested = size(line.qty, line.unit);
  if (
    !physical ||
    !requested ||
    !variant.skuId ||
    !variant.spinId ||
    !variant.displayName ||
    !variant.isInStockAndAvailable ||
    !Number.isFinite(variant.price?.offerPrice) ||
    variant.price.offerPrice < 0
  )
    return;
  const requestedAsPacks = line.unit === "packet" || line.unit === "bunch";
  const catalogUnit = units[catalog[line.item]?.unit ?? ""]?.[0];
  if (catalogUnit && catalogUnit !== "pack" && physical.unit !== catalogUnit) return;
  if (!requestedAsPacks && requested.unit !== physical.unit) return;
  const count = Math.ceil(requestedAsPacks ? line.qty : requested.amount / physical.amount);
  if (
    count < 1 ||
    (requestedAsPacks && count > 3) ||
    physical.amount * count > limits[physical.unit] ||
    count > (variant.maxQuantity ?? Infinity)
  )
    return;
  return { variant, count, size: physical, item: line.item };
}

const invalidCart = (message: string) => Object.assign(new Error(message), { status: 409 });

// Unmatched existing SKUs might be another brand of the same ingredient. Count them conservatively.
export function checkedItems(existing: CartItem[], options: PickedPack[][] = [], picked: PickedPack[] = []) {
  const bySku = new Map(options.flat().map((p) => [p.variant.skuId, p]));
  const result = existing.map(({ spinId, skuId, quantity }) => ({ spinId, skuId, quantity }));
  const totals: Record<Size["unit"], Map<string, number>> = {
    g: new Map(),
    ml: new Map(),
    piece: new Map(),
    pack: new Map(),
  };
  const record = (item: string, physical: Size, count: number) => {
    const ledger = totals[physical.unit];
    ledger.set(item, (ledger.get(item) ?? 0) + physical.amount * count);
    if (physical.unit !== "pack" && units[catalog[item]?.unit ?? ""]?.[0] === "pack") {
      totals.pack.set(item, (totals.pack.get(item) ?? 0) + count);
    }
  };
  for (const item of existing) {
    const pack = parsePack(item.itemVariant);
    if (!pack || !item.skuId || !item.spinId || !Number.isSafeInteger(item.quantity) || item.quantity <= 0) {
      throw invalidCart("Review the existing cart in Swiggy. A pack size could not be verified.");
    }
    const candidates = Object.keys(catalog).filter((id) => sameGrocery(id, item.itemName));
    const known = bySku.get(item.skuId);
    if (
      known &&
      (pack.unit !== known.size.unit || pack.amount !== known.size.amount || item.spinId !== known.variant.spinId)
    ) {
      throw invalidCart("The retailer returned conflicting pack sizes. Check the cart in Swiggy.");
    }
    const canonical = known?.item ?? (candidates.length === 1 ? candidates[0] : undefined);
    const expected = canonical ? units[catalog[canonical]?.unit ?? ""]?.[0] : undefined;
    if (
      (!canonical && (pack.unit === "pack" || pack.unit === "piece")) ||
      (expected && expected !== "pack" && expected !== pack.unit)
    )
      throw invalidCart("Confirm the existing pack sizes in Swiggy before adding groceries.");
    record(canonical ?? "", pack, item.quantity);
  }
  for (const p of picked) {
    record(p.item, p.size, p.count);
    const prior = result.find((r) => r.skuId === p.variant.skuId && r.spinId === p.variant.spinId);
    if ((prior?.quantity ?? 0) + p.count > (p.variant.maxQuantity ?? Infinity))
      throw invalidCart("The store has fewer packs available.");
    if (prior) prior.quantity += p.count;
    else result.push({ skuId: p.variant.skuId, spinId: p.variant.spinId, quantity: p.count });
  }
  for (const unit of ["g", "ml", "piece", "pack"] as const) {
    const ledger = totals[unit];
    // Unknown labels may refer to the same grocery as any identified SKU of this physical unit.
    const unknown = ledger.get("") ?? 0;
    for (const [item, amount] of ledger) {
      const total = item ? amount + unknown : unknown;
      if (total > limits[unit]) {
        const label = item ? (catalog[item]?.name ?? item) : "Unidentified groceries";
        const uncertainty = unknown && item ? " including unidentified packs" : "";
        throw invalidCart(
          `${label}: ${total} ${unit}${uncertainty}. The household limit is ${limits[unit]} ${unit}. Adjust the cart in Swiggy.`,
        );
      }
    }
  }
  return result;
}
