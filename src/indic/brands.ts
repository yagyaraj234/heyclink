import { normalizeAlias, resolveAlias } from "./alias-matching.ts";

const aliases: Record<string, string> = {
  "24-mantra": "२४ मंत्रा|౨౪ మంత్రా|24 mantra organic|24 मंत्रा|24 మంత్రా",
  aachi: "आची|ఆచి",
  aashirvaad: "ashirwad|आशीर्वाद|ఆశీర్వాద్",
  amul: "अमूल|అమూల్",
  ariel: "एरियल|ఏరియల్",
  bambino: "बाम्बिनो|బాంబినో",
  "bb-royal": "बीबी रॉयल|బీబీ రాయల్",
  "bella-vita": "बेला वीटा|బెల్లా విటా|bella vita organic",
  britannia: "ब्रिटानिया|బ్రిటానియా",
  bru: "ब्रू|బ్రూ",
  "clinic-plus": "क्लिनिक प्लस|క్లినిక్ ప్లస్",
  colgate: "कोलगेट|కోల్గేట్",
  cremica: "क्रेमिका|క్రెమికా",
  cycle: "साइकिल|సైకిల్",
  daawat: "दावत|దావత్",
  dabur: "डाबर|డాబర్",
  dove: "डव|డవ్",
  everest: "एवरेस्ट|ఎవరెస్ట్",
  figaro: "फिगारो|ఫిగారో",
  fortune: "फॉर्च्यून|ఫార్చ్యూన్",
  freedom: "फ्रीडम|ఫ్రీడమ్",
  fresho: "फ्रेशो|ఫ్రెషో",
  haldiram: "हल्दीराम|హల్దీరామ్|haldiram s|haldirams",
  harpic: "हार्पिक|హార్పిక్",
  "harvest-gold": "हार्वेस्ट गोल्ड|హార్వెస్ట్ గోల్డ్",
  "head-and-shoulders": "हेड एंड शोल्डर्स|హెడ్ అండ్ షోల్డర్స్|head shoulders",
  henko: "हेंको|హెంకో|हैंको",
  heritage: "हेरिटेज|హెరిటేజ్",
  himalaya: "हिमालया|హిమాలయ",
  "india-gate": "इंडिया गेट|ఇండియా గేట్",
  ldh: "l d h|एल डी एच|ఎల్ డీ హెచ్",
  lizol: "लिज़ोल|లైజాల్",
  lux: "लक्स|లక్స్",
  maggi: "मैगी|మ్యాగీ",
  mdh: "m d h|एम डी एच|ఎం డీ హెచ్",
  modern: "मॉडर्न|మోడరన్",
  "mother-dairy": "मदर डेयरी|మదర్ డెయిరీ",
  mtr: "m t r|एम टी आर|ఎం టీ ఆర్",
  nescafe: "नेस्कैफे|నెస్కాఫే|nescafé",
  nestle: "नेस्ले|నెస్లే|nestlé",
  parachute: "पैराशूट|పారాచూట్",
  "parle-g": "पार्ले जी|పార్లే జీ|parle|पार्ले|పార్లే",
  pepsodent: "पेप्सोडेंट|పెప్సోడెంట్",
  pillsbury: "पिल्सबरी|పిల్స్‌బరీ",
  quaker: "क्वेकर|క్వేకర్",
  rajdhani: "राजधानी|రాజధాని",
  "red-label": "रेड लेबल|రెడ్ లేబుల్",
  saffola: "सफोला|సఫోలా",
  santoor: "संतूर|సంతూర్",
  "slurrp-farm": "स्लर्प फार्म|స్లర్ప్ ఫామ్|slurp farm|slurp-firm|slurfm|స్లర్ప్ ఫర్మ్|స్లర్ఫమ్",
  sunfeast: "सनफीस्ट|సన్‌ఫీస్ట్",
  "surf-excel": "सर्फ एक्सेल|సర్ఫ్ ఎక్సెల్|surf|सर्फ|సర్ఫ్",
  "taj-mahal": "ताज महल|తాజ్ మహల్",
  tata: "टाटा|టాటా",
  "tata-sampann": "टाटा सम्पन्न|టాటా సంపన్న",
  tide: "टाइड|టైడ్",
  vijaya: "विजया|విజయ",
  vim: "विम|విమ్",
};

const brands = new Map<string, string>();
for (const [id, names] of Object.entries(aliases)) {
  brands.set(normalizeAlias(id), id);
  for (const name of names.split("|")) brands.set(normalizeAlias(name), id);
}

export function resolveBrand(raw: string): string | null {
  return resolveAlias(raw, brands);
}
