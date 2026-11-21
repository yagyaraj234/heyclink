import type { Unit } from "../contracts.ts";

const unitAliases: Record<Unit, string> = {
  kg: "kg kilo kilogram kilos kilograms किलो किलोग्राम కిలో కిలోలు కిలోల కేజీ కేజీలు కేజీల",
  g: "g gram grams gm ग्राम గ్రాము గ్రాములు గ్రాముల",
  l: "l litre liter litres liters लीटर लिटर లీటర్ లీటరు లీటర్లు లీటర్ల",
  ml: "ml milliliter millilitre मिलीलीटर एमएल మిల్లీ మిల్లీలీటర్ మిల్లీలీటరు మిల్లీలీటర్లు మిల్లీలీటర్ల ఎంఎల్",
  packet: "packet pack packets packs packetlu पैकेट ప్యాకెట్ ప్యాకెట్ల ప్యాకెట్లు సంచి సంచులు సంచులో",
  piece: "piece pieces pc pcs nag नग पीस ముక్క ముక్కలు పీస్ పీసు పీసులు",
  dozen: "dozen darjan दर्जन డజను డజన్ డజన్లు డజన్ల",
  bunch: "bunch bunches gaddi गड्डी गड्डियां गड्डियाँ కట్ట కట్టలు కట్టల",
};

const units = new Map<string, Unit>();
for (const unit of Object.keys(unitAliases) as Unit[]) {
  for (const alias of unitAliases[unit].split(" ")) units.set(alias, unit);
}

const numberWords = [
  "ek एक oka ఒక ఒకటి ఒక్క ఒక్కటి", "do दो rendu రెండు", "teen tin तीन మూడు", "char chaar चार నాలుగు",
  "panch paanch पांच पाँच ఐదు అయిదు", "chhe che chhah छह छः ఆరు", "sat saat सात ఏడు",
  "aath ath आठ ఎనిమిది", "nau नौ తొమ్మిది", "das dus दस పది",
  "gyarah gyaarah ग्यारह పదకొండు", "barah baarah बारह పన్నెండు", "terah तेरह పదమూడు",
  "chaudah चौदह పద్నాలుగు పదునాలుగు", "pandrah पंद्रह पन्द्रह పదిహేను పదునయిదు",
  "solah सोलह పదహారు", "satrah सत्रह పదిహేడు", "atharah अठारह పద్దెనిమిది",
  "unnees unnis उन्नीस పంతొమ్మిది పందొమ్మిది", "bees bis बीस",
  "ikkees ikkis इक्कीस", "baais bais बाईस", "teis तेईस", "chaubees chaubis चौबीस",
  "pachchis pachchees पच्चीस", "chhabbees छब्बीस", "sattais सत्ताईस", "atthais अट्ठाईस",
  "untees untis उनतीस", "tees tis तीस",
  "iktees इकतीस", "battees बत्तीस", "taintees teentees तैंतीस", "chauntees चौंतीस",
  "paintees पैंतीस", "chhattees छत्तीस", "saintees सैंतीस", "adtees अड़तीस",
  "untalees उनतालीस", "chalees chalis चालीस",
  "iktalees इकतालीस", "bayalees बयालीस", "taintalees तैंतालीस", "chauvalees चवालीस चौवालीस",
  "paintalees पैंतालीस", "chhiyalees छियालीस", "saintalees सैंतालीस", "adtalees अड़तालीस",
  "unchaas उनचास", "pachaas pachas पचास",
  "ikyavan इक्यावन", "bavan baavan बावन", "tirpan तिरपन", "chauvan चौवन",
  "pachpan पचपन", "chhappan छप्पन", "sattavan सत्तावन", "atthavan अट्ठावन",
  "unsath उनसठ", "saath साठ",
  "iksath इकसठ", "baasath बासठ", "tirsath तिरसठ", "chaunsath चौंसठ",
  "painsath पैंसठ", "chhiyasath छियासठ", "sadsath सड़सठ", "adsath अड़सठ",
  "unhattar उनहत्तर", "sattar सत्तर",
  "ikhattar इकहत्तर", "bahattar बहत्तर", "tihattar तिहत्तर", "chauhattar चौहत्तर",
  "pachhattar पचहत्तर", "chhihattar छिहत्तर", "sathattar सतहत्तर", "athhattar अठहत्तर",
  "unasi उनासी", "assi अस्सी",
  "ikyasi इक्यासी", "bayasi बयासी", "tirasi तिरासी", "chaurasi चौरासी",
  "pachasi पचासी", "chhiyasi छियासी", "sattasi सत्तासी", "atthasi अट्ठासी",
  "navasi नवासी", "nabbe नब्बे",
  "ikyanve इक्यानवे", "baanve बानवे", "tiranve तिरानवे", "chauranve चौरानवे",
  "pachanve पचानवे", "chhiyanve छियानवे", "sattanve सत्तानवे", "atthanve अट्ठानवे",
  "ninyaanve ninyanve निन्यानवे",
];
const numbers = new Map<string, number>();
for (const [index, words] of numberWords.entries()) {
  for (const word of words.split(" ")) numbers.set(word, index + 1);
}

const teluguTens = [
  ["ఇరవై", 20], ["ముప్పై", 30], ["నలభై", 40], ["యాభై", 50], ["ఏభై", 50],
  ["అరవై", 60], ["డెబ్బై", 70], ["ఎనభై", 80], ["తొంభై", 90],
] as const;

const scales = [
  [1000, /^(?:(.+?) )?(?:hazaar|hazar|हज़ार|हजार|వెయ్యి)(?: (.+))?$/u],
  [100, /^(?:(.+?) )?(?:sau|सौ|నూరు)(?: (.+))?$/u],
  [100, /^(?:(.+?) ?)?వంద(?:లు?)?(?: ?(.+))?$/u],
] as const;

const fractions = new Map([
  ["paav", 0.25], ["pav", 0.25], ["पाव", 0.25],
  ["aadha", 0.5], ["adha", 0.5], ["आधा", 0.5],
  ["aadhi", 0.5], ["adhi", 0.5], ["आधी", 0.5],
  ["sava", 1.25], ["sawa", 1.25], ["सवा", 1.25],
  ["dedh", 1.5], ["डेढ़", 1.5],
  ["dhai", 2.5], ["dhaai", 2.5], ["ढाई", 2.5],
  ["paavu", 0.25], ["pavu", 0.25], ["పావు", 0.25],
  ["aara", 0.5], ["ara", 0.5], ["అర", 0.5],
  ["mukkal", 0.75], ["ముప్పావు", 0.75], ["ఒకటిన్నర", 1.5], ["రెండున్నర", 2.5],
  ["సున్నాపాయింట్ ఐదు", 0.5], ["సున్నా పాయింట్ ఐదు", 0.5],
]);
const offsets = new Map([
  ["saade", 0.5], ["sade", 0.5], ["sadhe", 0.5], ["साढ़े", 0.5],
  ["sava", 0.25], ["sawa", 0.25], ["सवा", 0.25],
  ["paune", -0.25], ["pone", -0.25], ["पौने", -0.25],
]);

function parseNumber(raw: string): number {
  if (/^\d+(?:\.\d+)?$/u.test(raw)) return Number(raw);
  const exact = numbers.get(raw);
  if (exact !== undefined) return exact;

  for (const [word, tens] of teluguTens) {
    if (!raw.startsWith(word)) continue;
    const suffix = raw.slice(word.length).trimStart();
    if (!suffix) return tens;
    const ones = /^\p{Script=Telugu}+$/u.test(suffix) ? numbers.get(suffix) : undefined;
    return ones !== undefined && ones < 10 ? tens + ones : NaN;
  }
  return NaN;
}

function parseUnscaled(raw: string, impliedBase = NaN): number {
  const fraction = fractions.get(raw);
  if (fraction !== undefined) return fraction;

  const standaloneOffset = offsets.get(raw);
  if (standaloneOffset !== undefined) return impliedBase + standaloneOffset;

  const offset = /^(\S+) (.+)$/u.exec(raw);
  if (offset?.[1] && offset[2]) {
    const amount = offsets.get(offset[1]);
    if (amount !== undefined) return parseNumber(offset[2]) + amount;
  }
  return parseNumber(raw);
}

function parseQuantity(raw: string, maxScale = Infinity): number {
  for (const [scale, pattern] of scales) {
    if (scale >= maxScale) continue;
    const match = pattern.exec(raw);
    if (!match) continue;

    const count = match[1] === undefined ? 1 : parseUnscaled(match[1], 1);
    const remainder = match[2] === undefined ? 0 : parseQuantity(match[2], scale);
    if (!(count > 0 && count < 100 && remainder >= 0 && remainder < scale)) return NaN;
    return count * scale + remainder;
  }

  if (maxScale > 100 && raw.startsWith("నూట")) {
    if (raw === "నూటొక్కటి" || raw === "నూటొకటి") return 101;
    const remainder = parseNumber(raw.slice("నూట".length).trimStart());
    return remainder > 0 && remainder < 100 ? 100 + remainder : NaN;
  }
  return parseUnscaled(raw);
}

export function normalizeQuantity(raw: string): { qty: number; unit: Unit } | null {
  const text = raw.normalize().trim().toLowerCase().replace(/\s+/gu, " ")
    .replace(/[\u200c\u200d]/gu, "")
    .replace(/[०-९]/gu, (digit) => String(digit.charCodeAt(0) - 0x0966))
    .replace(/[౦-౯]/gu, (digit) => String(digit.charCodeAt(0) - 0x0c66))
    .replace(/ చిన్న (సంచి|సంచులు|సంచులో)$/u, " $1")
    .replace(/మిల్లీ (?=లీట\S*$)/u, "మిల్లీ")
    .replace(/^(అర|పావు|ముప్పావు|ఒకటిన్నర|రెండున్నర)(\p{Script=Telugu}+)$/u, "$1 $2");
  const match = /^(.+?)(?: |(?<=\d))([\p{L}\p{M}]+)$/u.exec(text);
  if (!match?.[1] || !match[2]) return null;

  const qty = parseQuantity(match[1]);
  if (qty === 1 && /^(?:paa?v|पाव)$/u.test(match[2])) return { qty: 0.25, unit: "kg" };

  const unit = units.get(match[2]);
  return unit && Number.isFinite(qty) && qty > 0 ? { qty, unit } : null;
}
