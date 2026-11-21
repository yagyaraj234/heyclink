import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { CallResult, Extraction, Household, Llm, Stt } from "./contracts.ts";
import case01 from "../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import { createApp } from "./app.ts";
import { processCall } from "./pipeline/process.ts";

// Fakes only for the Stt/Llm ports. The Llm replies in the pipeline's extraction-schema shape.
const llmReplying = (ex: Extraction): Llm => ({
  json: async <T>() =>
    ({
      groceries: ex.groceries.map((g) => ({ ...g, itemWord: g.item, qtyPhrase: "", brand: g.brand ?? null })),
      advance: ex.advance ? { amount: ex.advance.amount, reason: null } : null,
      notes: ex.notes,
    }) as T,
});
const fakeLlm = llmReplying(case01.gold as Extraction);
const fakeStt = (seen: { path?: string; bytes?: string } = {}): Stt => ({
  async transcribe(audioPath) {
    seen.path = audioPath;
    seen.bytes = existsSync(audioPath) ? readFileSync(audioPath, "utf8") : undefined;
    return { text: case01.transcript, lang: "hi", provider: "fake" };
  },
});

async function serve(stt: Stt = fakeStt()) {
  const server = createApp({ processCall, stt, llm: fakeLlm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { base, post, close: () => server.close() };
}

test("POST /calls with a transcript returns cards; approving them pays and updates memory", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);

  const res = await post("/calls", { transcript: case01.transcript, lang: "hi", householdId: "h1" });
  assert.equal(res.status, 201);
  const call = (await res.json()) as CallResult;
  assert.equal(call.transcript.text, case01.transcript);
  assert.deepEqual(call.actions.map((a) => a.type), ["cart", "advance"]);
  const cart = call.actions[0]!;
  const advance = call.actions[1]!;
  assert.ok(cart.type === "cart" && cart.cart.total === 196 && !cart.needsApproval);
  assert.equal(typeof call.timings.totalMs, "number");

  assert.deepEqual(await (await fetch(`${base}/calls/${call.callId}`)).json(), call);

  const adv = await post(`/actions/${advance.id}/approve`);
  assert.deepEqual(await adv.json(), {
    status: "approved",
    upiUrl: "upi://pay?pa=lakshmi@okaxis&pn=Lakshmi&am=500&cu=INR&tn=Advance",
  });

  assert.deepEqual(await (await post(`/actions/${cart.id}/approve`)).json(), { status: "approved" });
  assert.deepEqual(await (await post(`/actions/${cart.id}/approve`)).json(), { status: "approved" }); // idempotent

  const h = (await (await fetch(`${base}/households/h1`)).json()) as Household;
  assert.equal(h.history.length, 2);
  assert.deepEqual(h.history[1]?.lines, [
    { item: "atta", qty: 2, unit: "kg", brand: "aashirvaad" },
    { item: "coriander", qty: 2, unit: "bunch" },
    { item: "milk", qty: 1, unit: "packet", brand: "amul" },
  ]);
});

test("POST /calls with raw audio hands Stt a temp file with the right extension, then deletes it", async (t) => {
  const seen: { path?: string; bytes?: string } = {};
  const { base, close } = await serve(fakeStt(seen));
  t.after(close);

  const res = await fetch(`${base}/calls?householdId=h1`, {
    method: "POST",
    headers: { "content-type": "audio/webm;codecs=opus" },
    body: "fake-opus-bytes",
  });
  assert.equal(res.status, 201);
  assert.match(seen.path ?? "", /\.webm$/);
  assert.equal(seen.bytes, "fake-opus-bytes");
  assert.equal(existsSync(seen.path!), false);
  assert.deepEqual(((await res.json()) as CallResult).actions.map((a) => a.type), ["cart", "advance"]);
});

test("unknown household, empty input and unknown action are client errors", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);
  assert.equal((await post("/calls", { transcript: "atta", householdId: "nope" })).status, 404);
  assert.equal((await post("/calls", { householdId: "h1" })).status, 400);
  assert.equal((await post("/actions/nope/approve")).status, 404);
  assert.equal((await fetch(`${base}/calls/nope`)).status, 404);
  assert.equal((await fetch(`${base}/households/nope`)).status, 404);
});

test("answering a question 'yes' adds the line to the call's cart and recomputes total", async (t) => {
  const unsureLlm = llmReplying({
    groceries: [
      { raw: "do gaddi dhaniya", item: "coriander", qty: 2, unit: "bunch", confidence: 1 },
      { raw: "thoda methi", item: "methi", qty: 1, unit: "bunch", confidence: 0.59 },
      { raw: "woh wala tel", item: "sunflower-oil", qty: 1, unit: "l", confidence: 0.3 },
    ],
    notes: [],
  });
  const server = createApp({ processCall, stt: fakeStt(), llm: unsureLlm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const call = (await (await post("/calls", { transcript: "x", householdId: "h1" })).json()) as CallResult;
  const [, methiQ, oilQ] = call.actions;
  assert.deepEqual(call.actions.map((a) => a.type), ["cart", "question", "question"]);

  const yes = await post(`/actions/${methiQ!.id}/answer`, { option: "Yes, add it" });
  assert.equal(yes.status, 200);
  const no = await post(`/actions/${oilQ!.id}/answer`, { option: "No, skip" });
  assert.deepEqual(await no.json(), { status: "answered" });
  assert.equal((await post(`/actions/${methiQ!.id}/answer`, { option: "No, skip" })).status, 409);
  assert.equal((await post(`/actions/${call.actions[0]!.id}/answer`, { option: "Yes, add it" })).status, 400);

  const after = (await (await fetch(`${base}/calls/${call.callId}`)).json()) as CallResult;
  const cart = after.actions[0]!;
  // coriander 2 × 15 = 30; methi 1 × 18 = 18
  assert.ok(cart.type === "cart");
  assert.deepEqual(cart.cart.lines.map((l) => l.item), ["coriander", "methi"]);
  assert.equal(cart.cart.total, 48);
});

test("answering 'yes' when every line was unsure creates an approvable cart card", async (t) => {
  const llm = llmReplying({ groceries: [{ raw: "woh atta", item: "atta", qty: 2, unit: "kg", confidence: 0.4 }], notes: [] });
  const server = createApp({ processCall, stt: fakeStt(), llm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const call = (await (await post("/calls", { transcript: "x", householdId: "h1" })).json()) as CallResult;
  assert.deepEqual(call.actions.map((a) => a.type), ["question"]);
  const res = (await (await post(`/actions/${call.actions[0]!.id}/answer`, { option: "Yes, add it" })).json()) as {
    cart: { id: string; cart: { total: number } };
  };
  // atta 2 kg, household brand aashirvaad @66 = 132
  assert.equal(res.cart.cart.total, 132);
  assert.deepEqual(await (await post(`/actions/${res.cart.id}/approve`, {})).json(), { status: "approved" });
  const after = (await (await fetch(`${base}/calls/${call.callId}`)).json()) as CallResult;
  assert.deepEqual(after.actions.map((a) => a.type), ["cart", "question"]);
});

test("CORS: preflight and responses allow the web origin", async (t) => {
  const server = createApp({ processCall, stt: fakeStt(), llm: fakeLlm, corsOrigin: "https://web.example" }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const pre = await fetch(`${base}/calls`, {
    method: "OPTIONS",
    headers: { origin: "https://web.example", "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
  });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get("access-control-allow-origin"), "https://web.example");
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
  assert.match(pre.headers.get("access-control-allow-headers") ?? "", /content-type/i);

  const get = await fetch(`${base}/households/h1`, { headers: { origin: "https://web.example" } });
  assert.equal(get.headers.get("access-control-allow-origin"), "https://web.example");
});
