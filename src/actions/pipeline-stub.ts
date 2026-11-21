// STUB of Lane 1's processCall (src/pipeline/), typed by the contract. Delete once Lane 1 merges.
import { randomUUID } from "node:crypto";
import type { CallInput, CallResult, Extraction, Household, Llm, Stt } from "../contracts.ts";
import { planActions } from "./plan.ts";

export type ProcessCall = (input: CallInput, household: Household, ports: { stt: Stt; llm: Llm }) => Promise<CallResult>;

export const processCall: ProcessCall = async (input, household, { stt, llm }) => {
  const t0 = performance.now();
  const transcript = await stt.transcribe(input.audioPath, { lang: input.lang ?? household.cook.lang, keywords: [] });
  const t1 = performance.now();
  const extraction = await llm.json<Extraction>({
    system: "Extract grocery lines, advance requests and notes from a cook's voice note.",
    user: transcript.text,
    schema: {},
    schemaName: "extraction",
  });
  const t2 = performance.now();
  const actions = await planActions(extraction, household);
  const t3 = performance.now();
  return {
    callId: randomUUID(),
    transcript,
    extraction,
    actions,
    timings: { sttMs: t1 - t0, extractMs: t2 - t1, planMs: t3 - t2, totalMs: t3 - t0 },
  };
};
