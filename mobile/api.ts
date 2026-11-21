import Constants from "expo-constants";

// The API runs on the same machine as the Expo dev server, so default to its LAN host on :3000.
export const API = process.env.EXPO_PUBLIC_API_URL ?? `http://${(Constants.expoConfig?.hostUri ?? "localhost").split(":")[0]}:3000`;
export const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status}`);
  return body as T;
}
export const postJson = <T,>(path: string, body: unknown, ownerToken?: string) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json", ...(ownerToken && { authorization: "Bearer " + ownerToken }) }, body: JSON.stringify(body) });
