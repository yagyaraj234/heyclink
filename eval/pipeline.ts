// STUB until lane/pipeline (PR #1) merges. Then replace this file's body with:
//   export { processTranscript, processCall } from "../src/pipeline/process.ts";
//   export { openaiLlm } from "../src/pipeline/adapters/openai-llm.ts";
//   export { openaiStt } from "../src/pipeline/adapters/openai-stt.ts";
//   export { sarvamStt } from "../src/pipeline/adapters/sarvam-stt.ts";
import type { CallInput, CallResult, Extraction, Household, Lang, Llm, Stt } from "../src/contracts.ts";

export interface PipelineOptions {
  harness?: boolean;
}

export async function processTranscript(_text: string, _lang: Lang, _h: Household, _ports: { llm: Llm }, _o: PipelineOptions = {}): Promise<Extraction> {
  return { groceries: [], notes: [] };
}

export async function processCall(_input: CallInput, _h: Household, _ports: { stt: Stt; llm: Llm }, _o: PipelineOptions = {}): Promise<CallResult> {
  throw new Error("processCall stub: merge lane/pipeline first");
}

const unavailable = (name: string) => () => {
  throw new Error(`${name} stub: merge lane/pipeline first`);
};
export const openaiLlm: () => Llm = unavailable("openaiLlm");
export const openaiStt: () => Stt = unavailable("openaiStt");
export const sarvamStt: () => Stt = unavailable("sarvamStt");
