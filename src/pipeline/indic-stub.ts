// ponytail: stand-in for lane 3 (src/indic/). Same signatures; swap the import in process.ts once it merges.
import type { Unit } from "../contracts.ts";

export function normalizeQuantity(_raw: string): { qty: number; unit: Unit } | null {
  return null;
}

export function resolveItem(_raw: string): string | null {
  return null;
}
