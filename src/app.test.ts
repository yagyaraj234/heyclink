import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ActionCard, CallResult, Extraction, Household, Llm, Stt } from "./contracts.ts";
import case01 from "../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import { createApp } from "./app.ts";
import type { ProcessCall } from "./app.ts";
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

test("GET /health names the STT provider and LLM model and nothing else", async (t) => {
  const server = createApp({ processCall, stt: fakeStt(), llm: fakeLlm, health: { stt: "sarvam", llm: "gpt-test" } }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, stt: "sarvam", llm: "gpt-test" });
});

test("POST /calls?mode=plain runs the base model without household context and stores nothing", async (t) => {
  const prompts: string[] = [];
  const keywords: string[][] = [];
  // the LLM hears no brand, so any brand on the cart comes from household memory
  const reply = llmReplying({ groceries: [{ raw: "do kilo atta", item: "atta", qty: 2, unit: "kg", confidence: 1 }], advance: { amount: 500 }, notes: [] });
  const llm: Llm = { json: async (req) => (prompts.push(`${req.system}\n${req.user}`), reply.json(req)) };
  const stt: Stt = {
    async transcribe(_path, opts) {
      keywords.push(opts.keywords);
      return { text: "do kilo atta aur paanch sau advance", lang: "hi", provider: "fake" };
    },
  };
  const server = createApp({ processCall, stt, llm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const brands = /aashirvaad|india-gate/; // fixtures/household.json brands

  const text = await post("/calls?mode=plain", { transcript: "do kilo atta aur paanch sau advance", householdId: "h1" });
  const audio = await fetch(`${base}/calls?householdId=h1&mode=plain`, { method: "POST", headers: { "content-type": "audio/webm" }, body: "x" });
  for (const res of [text, audio]) {
    assert.equal(res.status, 200);
    const call = (await res.json()) as CallResult & { status: object };
    assert.deepEqual(call.status, {});
    assert.deepEqual(call.actions.map((a) => a.type), ["cart", "advance"]);
    const cart = call.actions[0]!;
    // atta 2 kg at base 58 = 116, no household brand (harness would price aashirvaad @66 = 132)
    assert.ok(cart.type === "cart");
    assert.deepEqual(cart.cart.lines.map((l) => [l.brand, l.price]), [[undefined, 116]]);
    assert.equal((await fetch(`${base}/calls/${call.callId}`)).status, 404);
    for (const a of call.actions) assert.equal((await post(`/actions/${a.id}/approve`, {})).status, 404);
  }
  assert.equal(prompts.length, 2);
  for (const p of prompts) assert.doesNotMatch(p, brands);
  assert.deepEqual(keywords, [[]]); // audio: no household STT keywords either
  assert.deepEqual(await (await fetch(`${base}/calls?householdId=h1`)).json(), []);

  // default mode is still the harness, and its prompt does carry the household
  const harness = (await (await post("/calls", { transcript: "do kilo atta", householdId: "h1" })).json()) as CallResult;
  assert.match(prompts[2]!, brands);
  const hCart = harness.actions[0]!;
  assert.ok(hCart.type === "cart");
  assert.deepEqual(hCart.cart.lines.map((l) => [l.brand, l.price]), [["aashirvaad", 132]]);
  assert.equal((await post("/calls?mode=bogus", { transcript: "atta", householdId: "h1" })).status, 400);
});

test("a fuzzy word becomes a which-one question; the chosen item joins the cart, Skip adds nothing", async (t) => {
  // the LLM marks a word it can't pin to one item with item: null plus candidates (extraction schema)
  const line = { qtyPhrase: "", confidence: 0.9, brand: null };
  const llm: Llm = {
    json: async <T>() => ({
      groceries: [
        { ...line, raw: "do kilo atta", itemWord: "atta", item: "atta", qty: 2, unit: "kg", confidence: 1 },
        { ...line, raw: "चना", itemWord: "चना", item: null, candidates: ["kabuli-chana", "kala-chana"], qty: 1, unit: "kg" },
        { ...line, raw: "dal", itemWord: "dal", item: null, candidates: ["toor-dal", "moong-dal"], qty: 500, unit: "g" },
      ],
      advance: null,
      notes: [],
    }) as T,
  };
  const server = createApp({ processCall, stt: fakeStt(), llm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  const call = (await (await post("/calls", { transcript: "do kilo atta aur ek kilo चना, aadha kilo dal", householdId: "h1" })).json()) as CallResult;
  const [cartCard, chanaQ, dalQ] = call.actions;
  assert.ok(chanaQ?.type === "question" && dalQ?.type === "question");
  assert.deepEqual(chanaQ.options, ["Kabuli Chana", "Kala Chana", "Skip"]);

  const kala = (await (await post(`/actions/${chanaQ.id}/answer`, { option: "Kala Chana" })).json()) as { status: string; cart: ActionCard };
  assert.equal(kala.status, "answered");
  assert.equal(kala.cart.id, cartCard!.id);
  assert.deepEqual(await (await post(`/actions/${dalQ.id}/answer`, { option: "Skip" })).json(), { status: "answered" });
  assert.equal((await post(`/actions/${dalQ.id}/answer`, { option: "Toor Dal" })).status, 409);

  const after = (await (await fetch(`${base}/calls/${call.callId}`)).json()) as CallResult;
  const cart = after.actions[0]!;
  assert.ok(cart.type === "cart");
  // atta 2 kg aashirvaad 2 × 66 = 132; kala-chana 1 kg in 500 g packs 2 × 55 = 110 (no household brand)
  assert.deepEqual(cart.cart.lines.map((l) => [l.item, l.qty, l.unit, l.brand, l.price]), [
    ["atta", 2, "kg", "aashirvaad", 132],
    ["kala-chana", 1, "kg", undefined, 110],
  ]);
  assert.equal(cart.cart.total, 242);
});

test("POST /calls hands processCall the household's last 5 calls as recent context; plain mode gets none", async (t) => {
  const prompts: string[] = [];
  const seen: unknown[] = [];
  const reply = llmReplying({ groceries: [{ raw: "do kilo atta", item: "atta", qty: 2, unit: "kg", confidence: 1 }], notes: [] });
  const llm: Llm = { json: async (req) => (prompts.push(req.user), reply.json(req)) };
  const tracking: ProcessCall = (input, household, ports, options) => (seen.push(options?.recent), processCall(input, household, ports, options));
  const server = createApp({ processCall: tracking, stt: fakeStt(), llm }).listen(0);
  await new Promise((r) => server.once("listening", r));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const say = (transcript: string, mode = "harness") =>
    fetch(`${base}/calls?mode=${mode}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript, householdId: "h1" }) });

  await say("pehli baar: do kilo atta");
  await say("doosri baar: woh wala chana bhi");
  assert.deepEqual(seen[0], []);
  const [first] = seen[1] as { at: string }[];
  assert.match(first!.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d/);
  assert.deepEqual(seen[1], [{ at: first!.at, transcript: "pehli baar: do kilo atta", lines: [{ item: "atta", qty: 2, unit: "kg" }] }]);
  assert.match(prompts[1]!, /pehli baar: do kilo atta/); // the second call's LLM sees the first call

  await say("plain: kuch bhi", "plain");
  assert.equal(seen[2], undefined);
  assert.doesNotMatch(prompts[2]!, /pehli baar/);

  for (const n of [3, 4, 5, 6]) await say(`call ${n}`);
  await say("call 7");
  // stored calls oldest → newest; the plain call was never stored
  assert.deepEqual((seen.at(-1) as { transcript: string }[]).map((r) => r.transcript),
    ["doosri baar: woh wala chana bhi", "call 3", "call 4", "call 5", "call 6"]);
});
