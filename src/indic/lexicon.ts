import itemIds from "../../fixtures/items.json" with { type: "json" };

const aliases: Record<string, string> = {
  atta: "aata|आटा|गेहूं का आटा|गेहूँ का आटा|gehun ka atta",
  maida: "मैदा",
  besan: "बेसन",
  sooji: "suji|rawa|rava|सूजी|रवा",
  rice: "chawal|chaawal|चावल|biyyam|బియ్యం",
  "basmati-rice": "basmati|basmati chawal|बासमती|बासमती चावल",
  poha: "पोहा",
  dalia: "daliya|दलिया",
  "ragi-flour": "ragi ka atta|ragi atta|रागी का आटा",
  "toor-dal": "tur dal|tuvar dal|arhar dal|तूर दाल|तुअर दाल|अरहर दाल|kandi pappu|కందిపప్పు|కంది పప్పు",
  "moong-dal": "mung dal|मूंग दाल|मूँग दाल",
  "masoor-dal": "masur dal|malka dal|मसूर दाल|मलका दाल",
  "chana-dal": "चना दाल",
  "urad-dal": "udad dal|urad daal|उड़द दाल",
  rajma: "राजमा",
  "kabuli-chana": "chole|safed chana|काबुली चना|छोले|सफेद चना",
  "kala-chana": "काला चना",
  onion: "pyaaz|pyaz|pyaj|pyaaj|kanda|प्याज़|कांदा|काँदा|ullipaya|ఉల్లిపాయ|ఉల్లిపాయలు",
  potato: "aloo|alu|आलू|bangaladumpa|బంగాళాదుంప|బంగాళాదుంపలు",
  tomato: "tamatar|tamaatar|टमाटर",
  garlic: "lahsun|lehsun|lasun|लहसुन",
  ginger: "adrak|अदरक",
  "green-chilli": "hari mirch|hari mirchi|hara mirch|हरी मिर्च|हरी मिर्ची|pacchi mirchi|పచ్చిమిర్చి|పచ్చి మిర్చి",
  coriander: "dhaniya|dhania|hara dhaniya|dhaniya patta|धनिया|हरा धनिया|धनिये के पत्ते|kothimeera|కొత్తిమీర",
  mint: "pudina|पुदीना",
  "curry-leaves": "kadi patta|kadipatta|curry patta|कड़ी पत्ता|करी पत्ता|karivepaku|కరివేపాకు",
  lemon: "nimbu|neembu|नींबू|नीम्बू",
  cucumber: "kheera|khira|खीरा",
  carrot: "gajar|gaajar|गाजर",
  cabbage: "patta gobhi|patta gobi|band gobhi|पत्ता गोभी|पत्तागोभी|बंद गोभी",
  cauliflower: "phool gobhi|phool gobi|फूल गोभी|फूलगोभी",
  brinjal: "baingan|baigan|eggplant|बैंगन|vankaya|వంకాయ",
  okra: "bhindi|भिंडी|भिण्डी",
  "bottle-gourd": "lauki|doodhi|ghiya|लौकी|दूधी|घिया",
  "bitter-gourd": "karela|करेला",
  "ridge-gourd": "turai|tori|तुरई|तोरी",
  capsicum: "shimla mirch|bell pepper|शिमला मिर्च",
  spinach: "palak|पालक",
  methi: "मेथी",
  peas: "matar|मटर",
  beans: "phali|फली|बीन्स",
  pumpkin: "kaddu|कद्दू",
  radish: "mooli|muli|मूली",
  beetroot: "chukandar|चुकंदर|चुकन्दर",
  "sweet-potato": "shakarkand|shakarkandi|शकरकंद|शकरकंदी",
  drumstick: "sahjan|sehjan|सहजन",
  "raw-banana": "kaccha kela|kachcha kela|कच्चा केला",
  mushroom: "khumb|मशरूम",
  corn: "bhutta|makka|भुट्टा|मक्का",
  banana: "kela|केला|केले",
  apple: "seb|सेब",
  orange: "santra|संतरा",
  papaya: "papita|पपीता",
  pomegranate: "anar|anaar|अनार",
  grapes: "angoor|अंगूर",
  mango: "aam|आम",
  watermelon: "tarbooz|tarbuj|तरबूज",
  guava: "amrud|amrood|अमरूद",
  milk: "doodh|dudh|दूध|paalu|పాలు",
  curd: "dahi|dahii|yogurt|दही|perugu|పెరుగు",
  paneer: "panir|पनीर",
  butter: "makhan|makkhan|मक्खन",
  ghee: "ghi|घी",
  cheese: "cheez|चीज़",
  cream: "malai|मलाई",
  buttermilk: "chaach|chhachh|छाछ",
  eggs: "anda|ande|egg|अंडा|अंडे|अण्डे",
  bread: "ब्रेड",
  pav: "paav|पाव",
  salt: "namak|नमक|uppu|ఉప్పు",
  sugar: "chini|cheeni|चीनी",
  jaggery: "gud|gur|गुड़",
  tea: "chai|chai patti|चाय|चाय पत्ती",
  coffee: "कॉफी",
  turmeric: "haldi|हल्दी|pasupu|పసుపు",
  "red-chilli-powder": "lal mirch powder|laal mirch powder|लाल मिर्च पाउडर",
  "coriander-powder": "dhaniya powder|dhania powder|धनिया पाउडर",
  "cumin-seeds": "jeera|jira|जीरा",
  "mustard-seeds": "rai|sarson ke daane|राई|सरसों के दाने",
  "garam-masala": "गरम मसाला|गर्म मसाला",
  hing: "heeng|हींग",
  ajwain: "अजवाइन",
  fennel: "saunf|सौंफ",
  cardamom: "elaichi|ilaichi|इलायची",
  cloves: "laung|long|लौंग",
  cinnamon: "dalchini|दालचीनी",
  "bay-leaf": "tej patta|तेज पत्ता|तेजपत्ता",
  "black-pepper": "kali mirch|kaali mirch|काली मिर्च",
  "kasuri-methi": "kasoori methi|कसूरी मेथी",
  "chaat-masala": "चाट मसाला",
  "sambar-powder": "sambhar powder|सांभर पाउडर|सांबर पाउडर",
  "mustard-oil": "sarson ka tel|sarso ka tel|सरसों का तेल",
  "sunflower-oil": "surajmukhi ka tel|सूरजमुखी का तेल",
  "groundnut-oil": "moongfali ka tel|मूंगफली का तेल",
  "coconut-oil": "nariyal ka tel|नारियल का तेल",
  "olive-oil": "jaitun ka tel|जैतून का तेल",
  peanuts: "moongfali|mungfali|groundnuts|मूंगफली|मूँगफली",
  cashew: "kaju|काजू",
  almonds: "badam|badaam|बादाम",
  raisins: "kishmish|किशमिश|kismis|కిస్మిస్|కిస్మిస్ పళ్ళు",
  coconut: "nariyal|नारियल",
  tamarind: "imli|इमली",
  vermicelli: "seviyan|sewai|सेवई|सेवइयां|सेवइयाँ",
  maggi: "मैगी",
  pasta: "पास्ता",
  oats: "ओट्स",
  biscuits: "biscuit|बिस्कुट",
  namkeen: "नमकीन",
  chicken: "murga|मुर्गा|चिकन",
  mutton: "मटन",
  fish: "machhli|machli|मछली",
  prawns: "jhinga|झींगा",
  "dishwash-liquid": "bartan dhone ka liquid|बर्तन धोने का लिक्विड",
  "dishwash-bar": "bartan dhone ka sabun|बर्तन धोने का साबुन",
  "detergent-powder": "washing powder|वाशिंग पाउडर",
  "floor-cleaner": "pocha liquid|फर्श क्लीनर",
  "toilet-cleaner": "टॉयलेट क्लीनर",
  "bath-soap": "nahane ka sabun|नहाने का साबुन",
  shampoo: "शैम्पू|शैम्पो",
  toothpaste: "टूथपेस्ट",
  "garbage-bags": "kachre ki thaili|कचरे की थैली",
  tissue: "tissue paper|टिशू पेपर",
  matchbox: "machis|माचिस",
  agarbatti: "अगरबत्ती",
  "ashwagandha-tablets": "ashwagandha tablets|अश्वगंधा टैबलेट्स|अश्वगंधा की गोलियाँ",
};

export const STT_KEYWORDS: string[] = [
  "atta", "maida", "besan", "sooji", "chawal", "basmati", "poha",
  "arhar dal", "moong dal", "masoor dal", "chana dal", "urad dal", "rajma",
  "pyaaz", "aloo", "tamatar", "lehsun", "adrak", "hari mirch", "dhaniya",
  "pudina", "kadi patta", "nimbu", "gajar", "lauki", "bhindi", "palak", "methi",
  "doodh", "dahi", "paneer", "ghee", "ande", "namak", "cheeni", "gud", "haldi",
  "jeera", "hing", "saunf", "sarson ka tel", "kishmish", "ashwagandha tablets",
];

function normalize(raw: string): string {
  return raw.normalize().toLowerCase().replace(/[\u093c\u200c\u200d]/gu, "")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
}

const lexicon = new Map<string, string>();
for (const id of itemIds) {
  for (const alias of aliases[id]?.split("|") ?? []) lexicon.set(normalize(alias), id);
}

for (const id of itemIds) lexicon.set(normalize(id), id);

function oneEditApart(shorter: string, longer: string): boolean {
  if (shorter.length > longer.length) return oneEditApart(longer, shorter);
  if (longer.length - shorter.length > 1) return false;

  let index = 0;
  while (index < shorter.length && shorter[index] === longer[index]) index++;
  const skip = shorter.length === longer.length ? 1 : 0;
  return shorter.slice(index + skip) === longer.slice(index + 1);
}

export function resolveItem(raw: string): string | null {
  const key = normalize(raw);
  const exact = lexicon.get(key);
  if (exact) return exact;
  if (key.length < 5) return null;

  let match: string | null = null;
  for (const [alias, id] of lexicon) {
    // Keep the edges exact to avoid treating a distinct word like "makhana" as "makhan".
    if (alias[0] !== key[0] || alias.at(-1) !== key.at(-1) || !oneEditApart(key, alias)) continue;
    if (match !== null && match !== id) return null;
    match = id;
  }
  return match;
}
