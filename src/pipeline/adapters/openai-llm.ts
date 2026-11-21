import type { Llm } from "../../contracts.ts";

// gpt-6-luna: OpenAI's "most efficient model for focused, high-volume tasks"; supports strict structured outputs
// and reasoning effort "none" (lowest latency). Extraction is a short, schema-bound task, so the cheap/fast tier fits.
export function openaiLlm(model = process.env.OPENAI_LLM_MODEL ?? "gpt-6-luna"): Llm {
  return {
    async json<T>({ system, user, schema, schemaName }: { system: string; user: string; schema: object; schemaName: string }): Promise<T> {
      const key = process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY not set");
      const res = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model,
          reasoning: { effort: "none" },
          input: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          text: { format: { type: "json_schema", name: schemaName, schema, strict: true } },
        }),
      });
      if (!res.ok) throw new Error(`openai responses ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as {
        status: string;
        incomplete_details?: { reason?: string };
        output: { type: string; content?: { type: string; text?: string; refusal?: string }[] }[];
      };
      if (body.status !== "completed") throw new Error(`openai responses ${body.status}: ${body.incomplete_details?.reason ?? ""}`);
      const parts = body.output.filter((o) => o.type === "message").flatMap((o) => o.content ?? []);
      const refusal = parts.find((p) => p.type === "refusal");
      if (refusal) throw new Error(`openai refused: ${refusal.refusal}`);
      const text = parts.find((p) => p.type === "output_text")?.text;
      if (!text) throw new Error("openai responses: no output_text");
      return JSON.parse(text) as T;
    },
  };
}
