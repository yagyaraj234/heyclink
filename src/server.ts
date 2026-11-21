import { createApp } from "./app.ts";
import { openStore } from "./actions/store.ts";
import { expoPush } from "./actions/alerts.ts";
import { runDue } from "./actions/orders.ts";
import { mockSwiggy } from "./actions/swiggy.ts";
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

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string (Neon: the pooled one)");
// Only the server runs checkout against this database.
const store = await openStore({ url });
const swiggy = mockSwiggy; // ponytail: mock orders until the Instamart spike is go
setInterval(() => void runDue(new Date(), store, swiggy, expoPush).catch(console.error), 60_000);

const origin = process.env.INSTAMART_PUBLIC_ORIGIN;
const clientId = process.env.INSTAMART_CLIENT_ID;
const instamart = origin ? { origin, clientId, staging: process.env.INSTAMART_STAGING === "1" } : undefined;
const port = Number(process.env.PORT ?? 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";
createApp({ processCall, stt, llm: openaiLlm(llmModel), corsOrigin, health: { stt: provider, llm: llmModel }, store, swiggy, instamart }).listen(port, () =>
  console.log(`voice-for-india on :${port} (stt=${provider}, llm=${llmModel}, cors=${corsOrigin})`),
);
