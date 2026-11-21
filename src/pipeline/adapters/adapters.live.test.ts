// LIVE=1 only (pnpm test:live). Hits real APIs; needs keys in .env and WAVs in src/pipeline/samples/ (gitignored).
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { Household } from "../../contracts.ts";
import household from "../../../fixtures/household.json" with { type: "json" };
import case01 from "../../../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import { processTranscript } from "../process.ts";
import { openaiLlm } from "./openai-llm.ts";
import { sarvamStt } from "./sarvam-stt.ts";
import { openaiStt } from "./openai-stt.ts";
import { whisperCppStt } from "./whisper-cpp-stt.ts";

const skip = !process.env.LIVE;
const wav = fileURLToPath(new URL("../samples/hi_bigbasket_1.wav", import.meta.url)); // "मैं दस पैकेट डाबर अश्वगंधा टैबलेट्स ख़रीदना चाहता हूँ"
const keywords = ["dabur", "ashwagandha"];

test("openai-llm: cook-hinglish-01 → gold items, wahi wala → aashirvaad, advance 500", { skip }, async () => {
  const ex = await processTranscript(case01.transcript, "hi", household as Household, { llm: openaiLlm() });
  assert.deepEqual(ex.groceries.map((l) => l.item).sort(), ["atta", "coriander", "milk"]);
  assert.equal(ex.groceries.find((l) => l.item === "atta")?.brand, "aashirvaad");
  assert.equal(ex.advance?.amount, 500);
});

test("sarvam-stt: Hindi bigbasket clip", { skip }, async () => {
  const t = await sarvamStt().transcribe(wav, { lang: "hi", keywords });
  assert.equal(t.lang, "hi");
  assert.equal(t.provider, "sarvam");
  assert.match(t.text, /अश्वगंधा/);
});

test("openai-stt: Hindi bigbasket clip", { skip }, async () => {
  const t = await openaiStt().transcribe(wav, { lang: "hi", keywords });
  assert.equal(t.lang, "hi");
  assert.equal(t.provider, "openai");
  assert.match(t.text, /अश्वगंधा/);
});

test("whisper-cpp-stt: Hindi bigbasket clip", { skip }, async () => {
  const t = await whisperCppStt().transcribe(wav, { lang: "hi", keywords });
  assert.equal(t.lang, "hi");
  assert.equal(t.provider, "whisper-cpp");
  assert.match(t.text, /डाबर/);
});
