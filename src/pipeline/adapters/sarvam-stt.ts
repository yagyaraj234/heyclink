import { audioBlob } from "./audio.ts";
import { basename } from "node:path";
import type { Stt } from "../../contracts.ts";
import { toLang } from "./lang.ts";

// Sync endpoint is meant for clips under ~30 s; longer audio needs Sarvam's batch API (not wired).
export function sarvamStt(model = "saaras:v4"): Stt {
  return {
    async transcribe(audioPath, { lang, keywords }) {
      const key = process.env.SARVAM_API_KEY;
      if (!key) throw new Error("SARVAM_API_KEY not set");
      const form = new FormData();
      form.append("file", await audioBlob(audioPath), basename(audioPath));
      form.append("model", model);
      form.append("mode", "transcribe");
      form.append("language_code", lang ? `${lang}-IN` : "unknown");
      if (keywords.length) form.append("keyterms", JSON.stringify(keywords.slice(0, 50).map((k) => k.slice(0, 64))));
      const res = await fetch("https://api.sarvam.ai/speech-to-text", {
        method: "POST",
        headers: { "api-subscription-key": key },
        body: form,
      });
      if (!res.ok) throw new Error(`sarvam stt ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { transcript: string; language_code?: string };
      return { text: body.transcript, lang: toLang(body.language_code, lang), provider: "sarvam" };
    },
  };
}
