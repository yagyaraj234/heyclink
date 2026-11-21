import type { Unit } from "../contracts.ts";

const unitAliases: Record<Unit, string> = {
  kg: "kg kilo kilogram kilos kilograms किलो किलोग्राम",
  g: "g gram grams gm ग्राम",
  l: "l litre liter litres liters लीटर लिटर",
  ml: "ml milliliter millilitre मिलीलीटर एमएल",
  packet: "packet pack packets packs पैकेट",
  piece: "piece pieces pc pcs nag नग पीस",
  dozen: "dozen darjan दर्जन",
  bunch: "bunch bunches gaddi गड्डी गड्डियां गड्डियाँ",
};

const units = new Map<string, Unit>();
for (const unit of Object.keys(unitAliases) as Unit[]) {
  for (const alias of unitAliases[unit].split(" ")) units.set(alias, unit);
}

const numberWords = [
  "ek एक", "do दो", "teen tin तीन", "char chaar चार", "panch paanch पांच पाँच",
  "chhe che chhah छह छः", "sat saat सात", "aath ath आठ", "nau नौ", "das dus दस",
  "gyarah gyaarah ग्यारह", "barah baarah बारह", "terah तेरह", "chaudah चौदह",
  "pandrah पंद्रह पन्द्रह", "solah सोलह", "satrah सत्रह", "atharah अठारह",
  "unnees unnis उन्नीस", "bees bis बीस",
];
const numbers = new Map<string, number>();
for (const [index, words] of numberWords.entries()) {
  for (const word of words.split(" ")) numbers.set(word, index + 1);
}
numbers.set("pachaas", 50);
numbers.set("pachas", 50);
numbers.set("पचास", 50);

const scales = [
  [1000, /^(?:(\S+) )?(?:hazaar|hazar|हज़ार|हजार)(?: (.+))?$/u],
  [100, /^(?:(\S+) )?(?:sau|सौ)(?: (.+))?$/u],
] as const;

const fractions = new Map([
  ["paav", 0.25], ["pav", 0.25], ["पाव", 0.25],
  ["aadha", 0.5], ["adha", 0.5], ["आधा", 0.5],
  ["dedh", 1.5], ["डेढ़", 1.5],
  ["dhai", 2.5], ["dhaai", 2.5], ["ढाई", 2.5],
]);
const offsets = new Map([
  ["saade", 0.5], ["sadhe", 0.5], ["साढ़े", 0.5],
  ["sava", 0.25], ["sawa", 0.25], ["सवा", 0.25],
  ["paune", -0.25], ["pone", -0.25], ["पौने", -0.25],
]);

function parseNumber(raw: string): number {
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  for (const [scale, pattern] of scales) {
    const match = pattern.exec(raw);
    if (!match) continue;

    const count = match[1] === undefined ? 1 : parseNumber(match[1]);
    const remainder = match[2] === undefined ? 0 : parseNumber(match[2]);
    if (!Number.isInteger(count) || count < 1 || count >= 100 || !(remainder < scale)) {
      return NaN;
    }
    return count * scale + remainder;
  }
  return numbers.get(raw) ?? NaN;
}

function parseQuantity(raw: string): number {
  const fraction = fractions.get(raw);
  if (fraction !== undefined) return fraction;

  const offset = /^(\S+) (.+)$/u.exec(raw);
  if (offset?.[1] && offset[2]) {
    const amount = offsets.get(offset[1]);
    if (amount !== undefined) return parseNumber(offset[2]) + amount;
  }
  return parseNumber(raw);
}

export function normalizeQuantity(raw: string): { qty: number; unit: Unit } | null {
  const text = raw.normalize().trim().toLowerCase().replace(/\s+/gu, " ")
    .replace(/[०-९]/gu, (digit) => String(digit.charCodeAt(0) - 0x0966));
  const match = /^(.+?)(?: |(?<=\d))([\p{L}\p{M}]+)$/u.exec(text);
  if (!match?.[1] || !match[2]) return null;

  const qty = parseQuantity(match[1]);
  const unit = units.get(match[2]);
  return unit && Number.isFinite(qty) && qty > 0 ? { qty, unit } : null;
}
