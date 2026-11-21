import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("POST /calls names the temp audio file by Content-Type so adapters can pick the MIME", async (t) => {
  const seen: { path?: string } = {};
  const { base, close } = await serve(fakeStt(seen));
  t.after(close);
  const cases: [contentType: string, ext: string][] = [
    ["audio/webm;codecs=opus", "webm"],
    ["audio/WEBM", "webm"],
    ["audio/ogg; codecs=opus", "ogg"],
    ["audio/mpeg", "mp3"],
    ["audio/mp4", "m4a"],
    ["audio/x-m4a", "m4a"],
    ["audio/wav", "wav"],
    ["audio/x-wav", "wav"],
    ["audio/wave", "wav"],
    ["audio/vnd.wave", "wav"],
    ["audio/flac", "flac"],
    ["audio/x-weird+thing", "bin"],
  ];
  for (const [contentType, ext] of cases) {
    const res = await fetch(`${base}/calls?householdId=h1`, { method: "POST", headers: { "content-type": contentType }, body: "x" });
    assert.equal(res.status, 201, contentType);
    assert.match(seen.path ?? "", new RegExp(`/vfi-[0-9a-f-]+\\.${ext}$`), contentType);
  }
});

test("GET /calls?householdId lists that household's calls, newest first", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);
  const first = (await (await post("/calls", { transcript: "do kilo atta", householdId: "h1" })).json()) as CallResult;
  const second = (await (await post("/calls", { transcript: "ek packet doodh", householdId: "h1" })).json()) as CallResult;

  const res = await fetch(`${base}/calls?householdId=h1`);
  assert.equal(res.status, 200);
  const list = (await res.json()) as CallResult[];
  assert.deepEqual(list.map((c) => c.callId), [second.callId, first.callId]);
  assert.equal(list[0]!.transcript.text, "ek packet doodh");

  assert.equal((await fetch(`${base}/calls?householdId=nope`)).status, 404);
  assert.equal((await fetch(`${base}/calls`)).status, 404);
});

test("serves the built web UI from webDir; API routes win over same-named files", async (t) => {
  const webDir = mkdtempSync(join(tmpdir(), "vfi-web-"));
  mkdirSync(join(webDir, "households"));
  writeFileSync(join(webDir, "index.html"), "<!doctype html><title>vfi</title>");
  writeFileSync(join(webDir, "households", "h1"), "static-shadow");
  writeFileSync(join(webDir, "calls"), "static-shadow");
  const server = createApp({ processCall, stt: fakeStt(), llm: fakeLlm, webDir }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.close();
    rmSync(webDir, { recursive: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const index = await fetch(`${base}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(await index.text(), "<!doctype html><title>vfi</title>");
  assert.equal(((await (await fetch(`${base}/households/h1`)).json()) as Household).id, "h1");
  assert.deepEqual(await (await fetch(`${base}/calls?householdId=h1`)).json(), []);
});

test("POST /households/:id/reset restores the fixture household and drops its calls", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);
  const fixture = await (await fetch(`${base}/households/h1`)).json();

  for (let round = 0; round < 2; round++) { // twice: a reset must not hand out the fixture object itself
    const call = (await (await post("/calls", { transcript: case01.transcript, householdId: "h1" })).json()) as CallResult;
    await post(`/actions/${call.actions[0]!.id}/approve`);
    assert.equal(((await (await fetch(`${base}/households/h1`)).json()) as Household).history.length, 2);

    const res = await post("/households/h1/reset");
    assert.equal(res.status, 200);
    assert.deepEqual(await (await fetch(`${base}/households/h1`)).json(), fixture);
    assert.deepEqual(await (await fetch(`${base}/calls?householdId=h1`)).json(), []);
    assert.equal((await fetch(`${base}/calls/${call.callId}`)).status, 404);
    assert.equal((await post(`/actions/${call.actions[0]!.id}/approve`)).status, 404);
  }
  assert.equal((await post("/households/nope/reset")).status, 404);
});

test("GET /calls and /calls/:id carry a per-action status map that survives reload", async (t) => {
  const llm = llmReplying({
    groceries: [
      { raw: "do gaddi dhaniya", item: "coriander", qty: 2, unit: "bunch", confidence: 1 },
      { raw: "thoda methi", item: "methi", qty: 1, unit: "bunch", confidence: 0.4 },
    ],
    advance: { amount: 500 },
    notes: [],
  });
  const server = createApp({ processCall, stt: fakeStt(), llm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  type WithStatus = CallResult & { status: Record<string, string> };
  const created = (await (await post("/calls", { transcript: "x", householdId: "h1" })).json()) as WithStatus;
  const [cart, advance, question] = created.actions;
  assert.deepEqual(created.actions.map((a) => a.type), ["cart", "advance", "question"]);
  assert.deepEqual(created.status, { [cart!.id]: "pending", [advance!.id]: "pending", [question!.id]: "pending" });

  await post(`/actions/${advance!.id}/approve`, {});
  await post(`/actions/${question!.id}/answer`, { option: "No, skip" });
  const want = { [cart!.id]: "pending", [advance!.id]: "approved", [question!.id]: "answered" };
  assert.deepEqual(((await (await fetch(`${base}/calls/${created.callId}`)).json()) as WithStatus).status, want);
  const list = (await (await fetch(`${base}/calls?householdId=h1`)).json()) as WithStatus[];
  assert.deepEqual(list[0]!.status, want);
});
