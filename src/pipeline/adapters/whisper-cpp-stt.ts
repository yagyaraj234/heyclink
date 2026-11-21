import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Stt } from "../../contracts.ts";
import { toLang } from "./lang.ts";

const run = promisify(execFile);

// Local, offline STT. `brew install whisper-cpp` plus a ggml model, e.g.
// https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin
// ponytail: spawns whisper-cli per call, so every call reloads the model (~seconds). Use whisper-server if latency matters.
export function whisperCppStt(
  model = process.env.WHISPER_MODEL ?? join(homedir(), ".cache/whisper.cpp/ggml-large-v3-turbo-q5_0.bin"),
  bin = process.env.WHISPER_CLI ?? "whisper-cli",
): Stt {
  return {
    async transcribe(audioPath, { lang, keywords }) {
      const args = ["-m", model, "-f", audioPath, "-l", lang ?? "auto", "-nt"];
      if (keywords.length) args.push("--prompt", keywords.join(", "));
      const { stdout, stderr } = await run(bin, args, { timeout: 120_000, maxBuffer: 16 << 20 });
      const detected = /auto-detected language: (\w+)/.exec(stderr)?.[1];
      return { text: stdout.trim(), lang: toLang(detected, lang), provider: "whisper-cpp" };
    },
  };
}
