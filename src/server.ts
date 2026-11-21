import { createApp } from "./app.ts";
import { processCall } from "./actions/pipeline-stub.ts";
import type { Llm, Stt } from "./contracts.ts";

// TODO(lane 1 merge): import processCall and the real Stt/Llm adapters from src/pipeline/.
const notMerged = (): never => {
  throw new Error("pipeline not wired yet: Lane 1 adapters pending");
};
const stt: Stt = { transcribe: async () => notMerged() };
const llm: Llm = { json: async () => notMerged() };

const port = Number(process.env.PORT ?? 3000);
createApp({ processCall, stt, llm }).listen(port, () => console.log(`voice-for-india on :${port}`));
