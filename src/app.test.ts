import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { CallResult, Household, Llm, Stt } from "./contracts.ts";
import case01 from "../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import { createApp } from "./app.ts";
import { processCall } from "./actions/pipeline-stub.ts";

// Fakes only for the Stt/Llm ports.
const fakeLlm: Llm = { json: async <T>() => structuredClone(case01.gold) as T };
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
