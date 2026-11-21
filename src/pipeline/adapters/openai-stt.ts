import { openAsBlob } from "node:fs";
import { basename } from "node:path";
import type { Stt } from "../../contracts.ts";
import { toLang } from "./lang.ts";

// gpt-transcribe: `languages` (array, replaces `language`) and `keywords` (array of literal terms) bias recognition.
export function openaiStt(model = "gpt-transcribe"): Stt {
  return {
    async transcribe(audioPath, { lang, keywords }) {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      const form = new FormData();
      form.append("file", await openAsBlob(audioPath, { type: "audio/wav" }), basename(audioPath));
      form.append("model", model);
      if (lang) form.append("languages[]", lang);
      for (const k of keywords) if (!/[<>\r\n]/.test(k)) form.append("keywords[]", k);
      const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: form,
      });
      if (!res.ok) throw new Error(`openai stt ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as { text: string; languages?: { code: string }[] };
      return { text: body.text, lang: toLang(body.languages?.[0]?.code, lang), provider: "openai" };
    },
  };
}
