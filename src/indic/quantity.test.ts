import assert from "node:assert/strict";
import test from "node:test";
import type { Unit } from "../contracts.ts";
import { normalizeQuantity } from "./index.ts";

const cases: [string, number, Unit][] = [
  ["250 gram", 250, "g"],
  ["do kilo", 2, "kg"],
  ["do gaddi", 2, "bunch"],
  ["ek packet", 1, "packet"],
  ["दस पैकेट", 10, "packet"],
  ["एक किलो", 1, "kg"],
  ["एक पैकेट", 1, "packet"],
  ["teen kilogram", 3, "kg"],
  ["चार ग्राम", 4, "g"],
  ["paanch liter", 5, "l"],
  ["छह लीटर", 6, "l"],
  ["saat ml", 7, "ml"],
  ["आठ pack", 8, "packet"],
  ["nau darjan", 9, "dozen"],
  ["एक दर्जन", 1, "dozen"],
  ["2 dozen", 2, "dozen"],
  ["दो गड्डी", 2, "bunch"],
  ["1 bunch", 1, "bunch"],
  ["gyarah piece", 11, "piece"],
  ["बारह nag", 12, "piece"],
  ["3 pc", 3, "piece"],
  ["sau g", 100, "g"],
  ["पाँच सौ ग्राम", 500, "g"],
  ["ek hazaar ml", 1000, "ml"],
  ["हज़ार मिलीलीटर", 1000, "ml"],
  ["दो हज़ार तीन सौ पचास ग्राम", 2350, "g"],
  ["१२५ ग्राम", 125, "g"],
  ["२.५ किलो", 2.5, "kg"],
  ["  250ML  ", 250, "ml"],
  ["  0.5   KG ", 0.5, "kg"],
  ["paav kilo", 0.25, "kg"],
  ["pav kilo", 0.25, "kg"],
  ["पाव किलो", 0.25, "kg"],
  ["aadha litre", 0.5, "l"],
  ["adha liter", 0.5, "l"],
  ["आधा लीटर", 0.5, "l"],
  ["dedh kilo", 1.5, "kg"],
  ["डेढ़ किलो", 1.5, "kg"],
  ["dhai kg", 2.5, "kg"],
  ["dhaai किलो", 2.5, "kg"],
  ["ढाई किलो", 2.5, "kg"],
  ["saade teen kg", 3.5, "kg"],
  ["साढ़े चार किलो", 4.5, "kg"],
  ["sava do litre", 2.25, "l"],
  ["सवा तीन लीटर", 3.25, "l"],
  ["paune 2 kilo", 1.75, "kg"],
  ["पौने एक किलो", 0.75, "kg"],
];

for (const [raw, qty, unit] of cases) {
  test(`normalizeQuantity(${JSON.stringify(raw)})`, () => {
    assert.deepEqual(normalizeQuantity(raw), { qty, unit });
  });
}

for (const raw of ["", "kilo", "dedh", "0 kg", "-2 kg", "1e3 g", "two bags", "do kilo pyaaz", "saade kilo", "do sau teen sau gram", "sava aadha kilo"]) {
  test(`normalizeQuantity rejects ${JSON.stringify(raw)}`, () => {
    assert.equal(normalizeQuantity(raw), null);
  });
}
