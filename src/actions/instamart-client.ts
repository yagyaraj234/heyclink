import { randomUUID } from "node:crypto";

export type CartItem = {
  skuId: string;
  spinId: string;
  itemName: string;
  itemVariant?: string;
  quantity: number;
  discountedFinalPrice: number;
  isInStockAndAvailable: boolean;
};
export type RetailCart = {
  items: CartItem[];
  cartAbsent?: boolean;
  selectedAddressDetails?: { id: string; address: string };
  selectedAddress?: string;
  cartTotalAmount: string;
  billBreakdown: { lineItems: { label: string; value: string }[]; toPay: { value: string } };
  addressWarning?: string;
  cartWarning?: { message: string };
  unserviceableItems?: CartItem[];
  removedOutOfStockItems?: CartItem[];
  reducedQuantityItems?: { spinId: string; requestedQuantity: number; itemName: string; cappedQuantity: number }[];
};
export type Variation = {
  skuId: string;
  spinId: string;
  displayName: string;
  brandName?: string;
  quantityDescription: string;
  price: { offerPrice: number };
  isInStockAndAvailable: boolean;
  sla?: { value: string; unit: string };
  maxQuantity?: number;
};
export type Addresses = { addresses: { id: string; addressLine: string }[]; pagination: { hasMore: boolean } };
export type SearchResults = {
  products: { displayName: string; brand?: string; inStock: boolean; isAvail: boolean; variations: Variation[] }[];
};

const fail = () =>
  Object.assign(new Error("Instamart could not complete the request. Check your cart in Swiggy before trying again."), {
    status: 502,
  });
export const swiggyOrigin = (staging = false) => (staging ? "https://mcp-staging.swiggy.com" : "https://mcp.swiggy.com");
export async function connectInstamart(token: string, network: typeof fetch = fetch, staging = false) {
  let protocol = "2025-03-26";
  async function rpc(method: string, params?: object) {
    const id = method.startsWith("notifications/") ? undefined : randomUUID();
    const response = await network(swiggyOrigin(staging) + "/im", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: "Bearer " + token,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": protocol,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    if ([401, 419].includes(response.status))
      throw Object.assign(new Error("Reconnect your Swiggy account from the app."), { status: 401 });
    if (!response.ok) throw fail();
    if (!id) return;
    const envelope = await response.json();
    if (envelope.id !== id || envelope.error || !envelope.result) throw fail();
    return envelope.result;
  }
  const init = await rpc("initialize", {
    protocolVersion: protocol,
    capabilities: {},
    clientInfo: { name: "Household Kitchen", version: "1" },
  });
  if (!["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].includes(init.protocolVersion)) throw fail();
  protocol = init.protocolVersion;
  await rpc("notifications/initialized");
  async function tool<T>(name: string, args: object): Promise<T> {
    const result = await rpc("tools/call", { name, arguments: args });
    if (result.isError) throw fail();
    const data = result.structuredContent ?? JSON.parse(result.content?.[0]?.text || "null");
    if (data?.success !== true || !data.data) throw fail();
    return data.data as T;
  }
  return {
    addresses: (page: number) => tool<Addresses>("get_addresses", { page }),
    search: (addressId: string, query: string) => tool<SearchResults>("search_products", { addressId, query }),
    cart: () => tool<RetailCart>("get_cart", {}),
    update: (selectedAddressId: string, items: Pick<CartItem, "skuId" | "spinId" | "quantity">[]) =>
      tool<RetailCart>("update_cart", { selectedAddressId, items }),
  };
}
export type Instamart = Awaited<ReturnType<typeof connectInstamart>>;
