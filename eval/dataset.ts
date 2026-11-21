import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Extraction, Lang } from "../src/contracts.ts";

export const IV_DIR = "eval/data/indicvoices";
export const RECORDED_AUDIO_DIR = "eval/data/recorded";

/** One row of eval/data/indicvoices/manifest.json (written by load-indicvoices.ts). */
export interface ClipMeta {
  id: string;
  lang: Lang;
  task: string;
  source: string;
  text: string;
  durationS: number;
  audioPath: string;
}

/** Same shape as fixtures/cases/*.json. */
export interface Case {
  id: string;
  source: string;
  lang: Lang;
  transcript: string;
  gold: Extraction;
}

export const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

export function readCases(dir: string): Case[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => readJson<Case>(`${dir}/${f}`));
}
