import type { Unit } from "../contracts.ts";
import type { GroceryReceipt } from "./store.ts";
import type { CartItem, RetailCart } from "./instamart-client.ts";
import { parsePack } from "./instamart-packs.ts";
import type { PickedPack } from "./instamart-packs.ts";

interface IntentItem {
  skuId: string;
  spinId: string;
  quantity: number;
  prior: number;
  pack?: { size: number; unit: Unit };
  variant?: string;
  added?: { item: string; brand?: string; eta?: string };
}
export interface InstamartIntent {
  address: string;
  items: IntentItem[];
  notes: string[];
}
const mismatch = () =>
  Object.assign(
    new Error(
      "The current Instamart cart does not match the reviewed packs and address. Check the cart in Swiggy before continuing.",
    ),
    { status: 409 },
  );

function physical(label?: string) {
  const p = parsePack(label);
  if (!p) throw mismatch();
  const unit: Unit = p.unit === "pack" ? (/bunch/i.test(label!) ? "bunch" : "packet") : p.unit;
  return { size: p.amount, unit };
}
export function makeIntent(
  address: string,
  payload: Pick<CartItem, "skuId" | "spinId" | "quantity">[],
  before: CartItem[],
  picked: PickedPack[],
  notes: string[],
): InstamartIntent {
  const items: IntentItem[] = payload.map((line) => {
    const previous = before.find((i) => i.skuId === line.skuId && i.spinId === line.spinId);
    const matches = picked.filter((p) => p.variant.skuId === line.skuId && p.variant.spinId === line.spinId);
    const p = matches[0];
    if (matches.some((other) => other.item !== p?.item)) throw mismatch();
    const row: IntentItem = { ...line, prior: previous?.quantity ?? 0 };
    if (p) {
      row.pack = physical(p.variant.quantityDescription);
      const brand = p.variant.brandName?.trim().toLowerCase().replace(/\s+/g, "-");
      row.added = {
        item: p.item,
        ...(brand && { brand }),
        ...(p.variant.sla && { eta: p.variant.sla.value + " " + p.variant.sla.unit }),
      };
    } else {
      row.variant = previous?.itemVariant;
    }
    return row;
  });
  return { address, items, notes };
}

// Only an acknowledged update can explain a smaller cart; a later get_cart supplies no such evidence.
export function acceptAdjustments(intent: InstamartIntent, updated: RetailCart): InstamartIntent {
  const adjusted = structuredClone(intent);
  for (const removed of updated.removedOutOfStockItems ?? []) {
    const i = adjusted.items.find((i) => i.spinId === removed.spinId && i.skuId === removed.skuId);
    if (!i) throw mismatch();
    i.quantity = 0;
    adjusted.notes.push(removed.itemName + " was removed");
  }
  for (const reduced of updated.reducedQuantityItems ?? []) {
    const matches = adjusted.items.filter((i) => i.spinId === reduced.spinId);
    const i = matches[0];
    if (
      matches.length !== 1 ||
      !i ||
      i.quantity !== reduced.requestedQuantity ||
      !Number.isSafeInteger(reduced.cappedQuantity) ||
      reduced.cappedQuantity < 0 ||
      reduced.cappedQuantity >= i.quantity
    )
      throw mismatch();
    i.quantity = reduced.cappedQuantity;
    adjusted.notes.push(reduced.itemName + " reduced to " + i.quantity);
  }
  return adjusted;
}

export function reconcile(intent: InstamartIntent | undefined, cart: RetailCart): GroceryReceipt["lines"] {
  if (!intent || cart.selectedAddressDetails?.id !== intent.address) throw mismatch();
  const remaining = new Map(intent.items.filter((i) => i.quantity > 0).map((i) => [i.skuId, i]));
  if (remaining.size !== cart.items.length) throw mismatch();
  const lines: GroceryReceipt["lines"] = [];
  for (const actual of cart.items) {
    if (cart.unserviceableItems?.some((u) => u.skuId === actual.skuId || u.spinId === actual.spinId)) throw mismatch();
    const i = remaining.get(actual.skuId);
    if (
      !i ||
      i.spinId !== actual.spinId ||
      i.quantity !== actual.quantity ||
      (!i.pack && i.variant !== actual.itemVariant) ||
      !actual.isInStockAndAvailable ||
      !Number.isFinite(actual.discountedFinalPrice) ||
      actual.discountedFinalPrice < 0
    )
      throw mismatch();
    const pack = i.pack;
    if (pack) {
      const billed = physical(actual.itemVariant);
      if (billed.unit !== pack.unit || billed.size !== pack.size) throw mismatch();
    }
    remaining.delete(actual.skuId);
    const count = i.quantity - i.prior;
    if (i.added && count > 0) {
      if (!pack) throw mismatch();
      const { item, brand } = i.added;
      lines.push({
        item,
        qty: pack.size * count,
        unit: pack.unit,
        ...(brand && { brand }),
        pack: { ...pack, count },
        price: Math.round(actual.discountedFinalPrice * count * 100) / 100,
      });
    }
  }
  if (remaining.size || !lines.length) throw mismatch();
  return lines;
}
