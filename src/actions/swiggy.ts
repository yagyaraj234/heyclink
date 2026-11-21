import { randomUUID } from "node:crypto";
import type { Cart, Platform } from "../contracts.ts";

/** Places a priced cart as a COD order. The real Instamart client (own-account OAuth) implements this once the spike is go. */
export interface Swiggy {
  platform: Platform;
  checkout(cart: Cart): Promise<{ orderId: string }>;
}

/** Labelled demo orders: nothing leaves the server. */
export const mockSwiggy: Swiggy = { platform: "mock", checkout: async () => ({ orderId: `mock-${randomUUID().slice(0, 8)}` }) };
