import { openAsBlob } from "node:fs";
import { extname } from "node:path";

const TYPES: Record<string, string> = { ".webm": "audio/webm", ".ogg": "audio/ogg", ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav" };

/** Audio file as a Blob typed from its extension (browsers record webm). */
export function audioBlob(path: string): Promise<Blob> {
  return openAsBlob(path, { type: TYPES[extname(path).toLowerCase()] ?? "application/octet-stream" });
}
