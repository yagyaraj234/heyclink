import { LANGS } from "../../contracts.ts";
import type { Lang } from "../../contracts.ts";

/** Clamp a provider's language code ("hi-IN", "ur", "") into our Lang union. */
export function toLang(code: string | undefined, hint: Lang | undefined): Lang {
  const c = code?.slice(0, 2).toLowerCase();
  return (LANGS as readonly string[]).includes(c ?? "") ? (c as Lang) : (hint ?? "hi");
}
