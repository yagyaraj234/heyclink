export function normalizeAlias(raw: string): string {
  return raw.normalize().toLowerCase().replace(/[\u093c\u200c\u200d]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

function oneEditApart(shorter: string, longer: string): boolean {
  if (shorter.length > longer.length) return oneEditApart(longer, shorter);
  if (longer.length - shorter.length > 1) return false;

  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index++;
  const skip = shorter.length === longer.length ? 1 : 0;
  return shorter.slice(index + skip) === longer.slice(index + 1);
}

export function resolveAlias(
  raw: string,
  aliases: ReadonlyMap<string, string>,
  exactOnly?: ReadonlySet<string>,
): string | null {
  const key = normalizeAlias(raw);
  const exact = aliases.get(key);
  if (exact !== undefined) return exact;
  if (key.length < 5) return null;

  let match: string | null = null;
  for (const [alias, id] of aliases) {
    if (alias[0] !== key[0] || alias.at(-1) !== key.at(-1) || exactOnly?.has(alias)) continue;
    if (!oneEditApart(key, alias)) continue;
    if (match !== null && match !== id) return null;
    match = id;
  }
  return match;
}
