import Constants from "expo-constants";
import { authEnabled, firebase } from "./auth.ts";

// The API runs on the same machine as the Expo dev server, so default to its LAN host on :3000.
export const API = process.env.EXPO_PUBLIC_API_URL ?? `http://${(Constants.expoConfig?.hostUri ?? "localhost").split(":")[0]}:3000`;
export const rupees = (n: number) => `₹${n.toLocaleString("en-IN")}`;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (authEnabled) {
    if (!API.startsWith("https://")) throw new Error("Sign-in requires an HTTPS API.");
    const auth = await firebase();
    const user = auth.getAuth().currentUser;
    if (!user) throw new ApiError(401, "Sign in to continue.");
    headers.set("authorization", "Bearer " + await auth.getIdToken(user));
  }
  const res = await fetch(API + path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${res.status}`);
  return body as T;
}
export const postJson = <T,>(path: string, body: unknown, ownerToken?: string) =>
  api<T>(path, { method: "POST", headers: { "content-type": "application/json", ...(ownerToken && { authorization: "Bearer " + ownerToken }) }, body: JSON.stringify(body) });

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
