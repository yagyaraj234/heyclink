import assert from "node:assert/strict";
import test from "node:test";
import catalog from "../actions/catalog.json" with { type: "json" };
import { resolveBrand } from "./index.ts";

const cases: [string, string | null][] = [
  ["slurrp-farm", "slurrp-farm"],
  ["slurp-firm", "slurrp-farm"],
  ["slurp farm", "slurrp-farm"],
  ["slurfm", "slurrp-farm"],
  ["hanko", "henko"],
  ["  SLURRP__FARM!  ", "slurrp-farm"],
  ["slurp form", "slurrp-farm"],
  ["sunfest", "sunfeast"],
  ["स्लर्प फर्म", "slurrp-farm"],
  ["స్లర్ఫమ్", "slurrp-farm"],
  ["స్లర్ప్ ఫర్మ్", "slurrp-farm"],
  ["हैंको", "henko"],
  ["ए डी एच", null],
  ["पार्ले", "parle-g"],
  ["parle", "parle-g"],
  ["పార్లే", "parle-g"],
  ["Nestlé", "nestle"],
  ["Nescafé", "nescafe"],
  ["Head & Shoulders", "head-and-shoulders"],
  ["Haldiram's", "haldiram"],
  ["haldirams", "haldiram"],
  ["24 Mantra Organic", "24-mantra"],
  ["24 మంత్రా", "24-mantra"],
  ["24 मंत्रा", "24-mantra"],
  ["सर्फ", "surf-excel"],
  ["సర్ఫ్", "surf-excel"],
  ["surf", "surf-excel"],
  ["Bella Vita Organic", "bella-vita"],
  ["अज्ञात ब्रांड", null],
  ["తెలియని బ్రాండ్", null],
  ["henko detergent", null],
  ["benko", null],
  ["henka", null],
  ["adul", null],
  ["h3nxo", null],
  ["", null],
];

for (const [raw, expected] of cases) {
  test(`resolveBrand(${JSON.stringify(raw)})`, () => {
    assert.equal(resolveBrand(raw), expected);
  });
}

const brandCases: [id: string, roman: string, devanagari: string, telugu: string][] = [
  ["24-mantra", "24 mantra", "२४ मंत्रा", "౨౪ మంత్రా"],
  ["aachi", "aachi", "आची", "ఆచి"],
  ["aashirvaad", "ashirwad", "आशीर्वाद", "ఆశీర్వాద్"],
  ["amul", "amul", "अमूल", "అమూల్"],
  ["ariel", "ariel", "एरियल", "ఏరియల్"],
  ["bambino", "bambino", "बाम्बिनो", "బాంబినో"],
  ["bb-royal", "bb royal", "बीबी रॉयल", "బీబీ రాయల్"],
  ["bella-vita", "bella vita", "बेला वीटा", "బెల్లా విటా"],
  ["britannia", "britannia", "ब्रिटानिया", "బ్రిటానియా"],
  ["bru", "bru", "ब्रू", "బ్రూ"],
  ["clinic-plus", "clinic plus", "क्लिनिक प्लस", "క్లినిక్ ప్లస్"],
  ["colgate", "colgate", "कोलगेट", "కోల్గేట్"],
  ["cremica", "cremica", "क्रेमिका", "క్రెమికా"],
  ["cycle", "cycle", "साइकिल", "సైకిల్"],
  ["daawat", "daawat", "दावत", "దావత్"],
  ["dabur", "dabur", "डाबर", "డాబర్"],
  ["dove", "dove", "डव", "డవ్"],
  ["everest", "everest", "एवरेस्ट", "ఎవరెస్ట్"],
  ["figaro", "figaro", "फिगारो", "ఫిగారో"],
  ["fortune", "fortune", "फॉर्च्यून", "ఫార్చ్యూన్"],
  ["freedom", "freedom", "फ्रीडम", "ఫ్రీడమ్"],
  ["fresho", "fresho", "फ्रेशो", "ఫ్రెషో"],
  ["haldiram", "haldiram", "हल्दीराम", "హల్దీరామ్"],
  ["harpic", "harpic", "हार्पिक", "హార్పిక్"],
  ["harvest-gold", "harvest gold", "हार्वेस्ट गोल्ड", "హార్వెస్ట్ గోల్డ్"],
  ["head-and-shoulders", "head and shoulders", "हेड एंड शोल्डर्स", "హెడ్ అండ్ షోల్డర్స్"],
  ["henko", "henko", "हेंको", "హెంకో"],
  ["heritage", "heritage", "हेरिटेज", "హెరిటేజ్"],
  ["himalaya", "himalaya", "हिमालया", "హిమాలయ"],
  ["india-gate", "india gate", "इंडिया गेट", "ఇండియా గేట్"],
  ["ldh", "l d h", "एल डी एच", "ఎల్ డీ హెచ్"],
  ["lizol", "lizol", "लिज़ोल", "లైజాల్"],
  ["lux", "lux", "लक्स", "లక్స్"],
  ["maggi", "maggi", "मैगी", "మ్యాగీ"],
  ["mdh", "m d h", "एम डी एच", "ఎం డీ హెచ్"],
  ["modern", "modern", "मॉडर्न", "మోడరన్"],
  ["mother-dairy", "mother dairy", "मदर डेयरी", "మదర్ డెయిరీ"],
  ["mtr", "m t r", "एम टी आर", "ఎం టీ ఆర్"],
  ["nescafe", "nescafe", "नेस्कैफे", "నెస్కాఫే"],
  ["nestle", "nestle", "नेस्ले", "నెస్లే"],
  ["parachute", "parachute", "पैराशूट", "పారాచూట్"],
  ["parle-g", "parle g", "पार्ले जी", "పార్లే జీ"],
  ["pepsodent", "pepsodent", "पेप्सोडेंट", "పెప్సోడెంట్"],
  ["pillsbury", "pillsbury", "पिल्सबरी", "పిల్స్‌బరీ"],
  ["quaker", "quaker", "क्वेकर", "క్వేకర్"],
  ["rajdhani", "rajdhani", "राजधानी", "రాజధాని"],
  ["red-label", "red label", "रेड लेबल", "రెడ్ లేబుల్"],
  ["saffola", "saffola", "सफोला", "సఫోలా"],
  ["santoor", "santoor", "संतूर", "సంతూర్"],
  ["slurrp-farm", "slurrp farm", "स्लर्प फार्म", "స్లర్ప్ ఫామ్"],
  ["sunfeast", "sunfeast", "सनफीस्ट", "సన్‌ఫీస్ట్"],
  ["surf-excel", "surf excel", "सर्फ एक्सेल", "సర్ఫ్ ఎక్సెల్"],
  ["taj-mahal", "taj mahal", "ताज महल", "తాజ్ మహల్"],
  ["tata", "tata", "टाटा", "టాటా"],
  ["tata-sampann", "tata sampann", "टाटा सम्पन्न", "టాటా సంపన్న"],
  ["tide", "tide", "टाइड", "టైడ్"],
  ["vijaya", "vijaya", "विजया", "విజయ"],
  ["vim", "vim", "विम", "విమ్"],
];

const catalogIds = Object.values(catalog).flatMap((entry) =>
  "brands" in entry ? Object.keys(entry.brands) : [],
);
assert.deepEqual(
  [...new Set(catalogIds)].filter((id) => !brandCases.some(([covered]) => covered === id)),
  [],
);

for (const [id, roman, devanagari, telugu] of brandCases) {
  for (const raw of new Set([id, roman, devanagari, telugu])) {
    test(`resolveBrand recognizes ${JSON.stringify(raw)} as ${id}`, () => {
      assert.equal(resolveBrand(raw), id);
    });
  }
}
