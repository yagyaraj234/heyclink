import type { AuthConfig } from "./actions/auth.ts";
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

const mode = process.env.AUTH_MODE;
if (mode !== "firebase" && mode !== "demo") throw new Error("Set AUTH_MODE to firebase or demo.");
if (process.env.FIREBASE_AUTH_EMULATOR_HOST && mode === "firebase") {
  throw new Error("The deployed Firebase auth server requires signed production tokens.");
}
const projectId = process.env.FIREBASE_PROJECT_ID;
const inviteOrigin = process.env.INVITE_ORIGIN;
if (mode === "firebase" && (!projectId || !inviteOrigin)) throw new Error("Set FIREBASE_PROJECT_ID and INVITE_ORIGIN.");
const auth: AuthConfig | undefined = mode === "firebase" ? {
  projectId: projectId!,
  inviteOrigin: inviteOrigin!,
  iosAppId: process.env.INVITE_IOS_APP_ID,
  androidPackage: "com.yagyaraj.kitchen",
  androidFingerprints: process.env.INVITE_ANDROID_SHA256?.split(",").map(value => value.trim()),
} : undefined;

const url = process.env.DATABASE_URL;
if (!url) throw new Error("Set DATABASE_URL to a Postgres connection string (Neon: the pooled one)");
// Only the server runs checkout against this database.
const store = await openStore({ url });
const swiggy = mockSwiggy; // ponytail: mock orders until the Instamart spike is go
setInterval(() => void runDue(new Date(), store, swiggy, expoPush).catch(console.error), 60_000);

const origin = process.env.INSTAMART_PUBLIC_ORIGIN;
const clientId = process.env.INSTAMART_CLIENT_ID;
const key = process.env.INSTAMART_CREDENTIAL_KEY;
const instamart = origin && auth ? {
  origin, clientId, staging: process.env.INSTAMART_STAGING === "1",
  credentialKey: key && /^[a-f0-9]{64}$/i.test(key) ? Buffer.from(key, "hex") : undefined,
} : undefined;
const port = Number(process.env.PORT ?? 3000);
const corsOrigin = process.env.CORS_ORIGIN || "*";
createApp({ processCall, stt, llm: openaiLlm(llmModel), corsOrigin, health: { stt: provider, llm: llmModel }, store, swiggy, instamart, auth }).listen(port, () =>
  console.log(`voice-for-india on :${port} (stt=${provider}, llm=${llmModel}, cors=${corsOrigin})`),
);
