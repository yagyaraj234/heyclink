import { createApp } from "./app.ts";
import { processCall } from "./pipeline/process.ts";
import { openaiLlm } from "./pipeline/adapters/openai-llm.ts";
import { openaiStt } from "./pipeline/adapters/openai-stt.ts";
import { sarvamStt } from "./pipeline/adapters/sarvam-stt.ts";
import { whisperCppStt } from "./pipeline/adapters/whisper-cpp-stt.ts";

// whisper-cpp reads WHISPER_MODEL / WHISPER_CLI; needs whisper-cli on the host.
const sttProviders = { sarvam: sarvamStt, openai: openaiStt, "whisper-cpp": whisperCppStt };
const provider = process.env.STT_PROVIDER || "sarvam";
if (!Object.hasOwn(sttProviders, provider)) {
  throw new Error(`STT_PROVIDER must be one of ${Object.keys(sttProviders).join(", ")}; got "${provider}"`);
}
const stt = sttProviders[provider as keyof typeof sttProviders]();

const llmModel = process.env.OPENAI_LLM_MODEL || "gpt-6-luna"; // passed explicitly so /health reports what runs

const port = Number(process.env.PORT ?? 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";
createApp({ processCall, stt, llm: openaiLlm(llmModel), corsOrigin, health: { stt: provider, llm: llmModel } }).listen(port, () =>
  console.log(`voice-for-india on :${port} (stt=${provider}, llm=${llmModel}, cors=${corsOrigin})`),
);
