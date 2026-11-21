import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { ActionCard, CallResult, Extraction, Household, Llm, Stt } from "./contracts.ts";
import case01 from "../fixtures/cases/cook-hinglish-01.json" with { type: "json" };
import { createApp } from "./app.ts";
import type { AppDeps, ProcessCall } from "./app.ts";
import { processCall } from "./pipeline/process.ts";
import { openStore } from "./actions/store.ts";

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

async function serve(stt: Stt = fakeStt(), deps: Partial<AppDeps> = {}) {
  const server = createApp({ processCall, stt, llm: fakeLlm, ...deps }).listen(0);
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body?: unknown) =>
    fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
  return { base, post, close: () => new Promise((r) => server.close(r)) };
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

const signup = {
  owner: { name: "Priya", phone: "+919800000001" },
  cook: { name: "Sunita", lang: "hi", upiId: "sunita@okicici", monthlySalary: 10000, offDays: ["sun"] },
  approvalLimit: 1500,
  brands: { atta: "aashirvaad" },
  goals: { goal: "lose", diet: "veg", proteinG: 90 },
};

test("POST /households signs up an owner and cook; the cook joins with the code and can send calls", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);

  const res = await post("/households", signup);
  assert.equal(res.status, 201);
  const { id, cookCode } = (await res.json()) as { id: string; cookCode: string };
  assert.match(cookCode, /^[A-Z0-9]{6}$/);

  const h = (await (await fetch(`${base}/households/${id}`)).json()) as Household;
  assert.deepEqual(h, {
    id,
    owner: { name: "Priya", phone: "+919800000001" },
    cook: { name: "Sunita", lang: "hi", upiId: "sunita@okicici", monthlySalary: 10000, offDays: ["sun"] },
    goals: { goal: "lose", diet: "veg", proteinG: 90 },
    family: { headcount: 1, dietRules: [] },
    brands: { atta: "aashirvaad" },
    pantry: {},
    platform: "mock",
    approvalLimit: 1500,
    history: [],
  });

  const join = await post("/join", { code: ` ${cookCode.toLowerCase()} ` });
  assert.equal(join.status, 200);
  assert.deepEqual(await join.json(), { householdId: id, role: "cook", cook: { name: "Sunita", lang: "hi" } });
  assert.equal((await post("/join", { code: "ZZZZZZ" })).status, 404);

  const call = await post("/calls", { transcript: case01.transcript, householdId: id });
  assert.equal(call.status, 201);
  // case01 gold brands: aashirvaad (wahi wala) and amul (said out loud); coriander has none
  const [cart] = ((await call.json()) as CallResult).actions;
  assert.ok(cart?.type === "cart");
  assert.deepEqual(cart.cart.lines.map((l) => [l.item, l.brand]), [["atta", "aashirvaad"], ["coriander", undefined], ["milk", "amul"]]);
  assert.equal(((await (await fetch(`${base}/calls?householdId=${id}`)).json()) as unknown[]).length, 1);
});

test("POST /households rejects bad input with 400", async (t) => {
  const { post, close } = await serve();
  t.after(close);
  const bad: [why: string, body: unknown][] = [
    ["no body", {}],
    ["no owner", { ...signup, owner: undefined }],
    ["owner without phone", { ...signup, owner: { name: "Priya" } }],
    ["no cook", { ...signup, cook: undefined }],
    ["cook without upiId", { ...signup, cook: { ...signup.cook, upiId: "" } }],
    ["unknown lang", { ...signup, cook: { ...signup.cook, lang: "fr" } }],
    ["salary as text", { ...signup, cook: { ...signup.cook, monthlySalary: "10000" } }],
    ["bad off day", { ...signup, cook: { ...signup.cook, offDays: ["sunday"] } }],
    ["negative limit", { ...signup, approvalLimit: -1 }],
    ["no limit", { ...signup, approvalLimit: undefined }],
    ["brand not a string", { ...signup, brands: { atta: 1 } }],
    ["unknown goal", { ...signup, goals: { goal: "bulk", diet: "veg" } }],
    ["unknown diet", { ...signup, goals: { goal: "lose", diet: "vegan" } }],
  ];
  for (const [why, body] of bad) assert.equal((await post("/households", body)).status, 400, why);
});

test("a restart on the same database keeps households, join codes, calls and approvals", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "vfi-db-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const boot = () => serve(fakeStt(), { store: openStore(join(dir, "vfi.db")) });

  const before = await boot();
  const { id, cookCode } = (await (await before.post("/households", signup)).json()) as { id: string; cookCode: string };
  const first = (await (await before.post("/calls", { transcript: "pehli", householdId: id })).json()) as CallResult;
  const second = (await (await before.post("/calls", { transcript: "doosri", householdId: id })).json()) as CallResult;
  const [cart, advance] = first.actions;
  await before.post(`/actions/${cart!.id}/approve`);
  await before.close();

  const after = await boot();
  t.after(after.close);
  const h = (await (await fetch(`${after.base}/households/${id}`)).json()) as Household;
  assert.equal(h.cook.name, "Sunita");
  assert.equal(h.history.length, 1);
  assert.deepEqual(await (await after.post("/join", { code: cookCode })).json(), { householdId: id, role: "cook", cook: { name: "Sunita", lang: "hi" } });

  type WithStatus = CallResult & { status: Record<string, string> };
  const list = (await (await fetch(`${after.base}/calls?householdId=${id}`)).json()) as WithStatus[];
  assert.deepEqual(list.map((c) => c.transcript.text), ["doosri", "pehli"]);
  assert.deepEqual(list[1]!.status, { [cart!.id]: "approved", [advance!.id]: "pending" });
  assert.deepEqual(list[0]!.actions, second.actions);
  assert.deepEqual(await (await after.post(`/actions/${advance!.id}/approve`)).json(), {
    status: "approved",
    upiUrl: "upi://pay?pa=sunita@okicici&pn=Sunita&am=500&cu=INR&tn=Advance",
  });

  // the fixture household is seeded once, not reset by a restart, and has a fixed demo code
  assert.equal(((await (await fetch(`${after.base}/households/h1`)).json()) as Household).id, "h1");
  assert.deepEqual(await (await after.post("/join", { code: "TADKA2" })).json(), { householdId: "h1", role: "cook", cook: { name: "Lakshmi", lang: "hi" } });
});

// planMeals' LLM reply shape (src/pipeline/meals.ts): only atta to buy, so the cart is hand-priceable
const mealMacros = { kcal: 400, proteinG: 20, carbsG: 50, fiberG: 8, fatG: 10 };
const mealLlm: Llm = {
  json: async <T>() => ({
    cook: { meals: [{ slot: "lunch", dish: "Roti sabzi", macros: mealMacros, steps: ["Knead", "Roll", "Cook"], ingredients: [{ item: "atta", qty: 2, unit: "kg" }] }] },
    order: { meals: [{ slot: "lunch", dish: "Veg thali", macros: mealMacros }] },
  }) as T,
};

test("POST /households/:id/meal-plan returns a meal-plan card; answering it counts the habit and 'cook' returns a cart", async (t) => {
  const { base, post, close } = await serve(fakeStt(), { llm: mealLlm });
  t.after(close);
  const plan = async () => {
    const res = await post("/households/h1/meal-plan", { date: "2026-11-22" }); // a Sunday
    assert.equal(res.status, 201);
    return (await res.json()) as Extract<ActionCard, { type: "meal-plan" }>;
  };

  const card = await plan();
  assert.equal(card.type, "meal-plan");
  assert.deepEqual(card.options, ["cook", "order"]);
  assert.equal(card.plan.date, "2026-11-22");
  assert.equal(card.plan.suggested, "cook"); // h1: no habits, no off days
  assert.equal(card.plan.order.meals[0]!.dish, "Veg thali");

  assert.equal((await post(`/actions/${card.id}/answer`, { option: "skip" })).status, 400);
  assert.equal((await post(`/actions/${card.id}/approve`)).status, 400);
  const cooked = (await (await post(`/actions/${card.id}/answer`, { option: "cook" })).json()) as { status: string; cart: ActionCard };
  assert.equal(cooked.status, "answered");
  // atta 2 kg, household brand aashirvaad @66 = 132; under h1's 2000 limit
  assert.ok(cooked.cart.type === "cart");
  assert.deepEqual(cooked.cart.cart.lines.map((l) => [l.item, l.brand, l.price]), [["atta", "aashirvaad", 132]]);
  assert.equal(cooked.cart.needsApproval, false);
  assert.equal((await post(`/actions/${card.id}/answer`, { option: "order" })).status, 409);
  assert.deepEqual(await (await post(`/actions/${cooked.cart.id}/approve`)).json(), { status: "approved" });

  const ordered = await plan();
  assert.deepEqual(await (await post(`/actions/${ordered.id}/answer`, { option: "order" })).json(), { status: "answered" });

  const h = (await (await fetch(`${base}/households/h1`)).json()) as Household;
  assert.deepEqual(h.habits, { sun: { cook: 1, order: 1 } });
  assert.deepEqual(h.history.at(-1)?.lines, [{ item: "atta", qty: 2, unit: "kg", brand: "aashirvaad" }]);

  assert.equal((await post("/households/nope/meal-plan", {})).status, 404);
  assert.equal((await post("/households/h1/meal-plan", { date: "22-11-2026" })).status, 400);
});

test("POST /households/:id/meal-plan defaults to tomorrow in India", async (t) => {
  const { post, close } = await serve(fakeStt(), { llm: mealLlm });
  t.after(close);
  const tomorrowIst = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(Date.now() + 86_400_000);
  const card = (await (await post("/households/h1/meal-plan")).json()) as Extract<ActionCard, { type: "meal-plan" }>;
  assert.equal(card.plan.date, tomorrowIst);
});

test("approving a cart with { order } creates an order card; approving that places it now or leaves it for the scheduler", async (t) => {
  const { base, post, close } = await serve();
  t.after(close);
  type OrderCard = Extract<ActionCard, { type: "order" }>;
  const newCart = async () => ((await (await post("/calls", { transcript: case01.transcript, householdId: "h1" })).json()) as CallResult);

  const call = await newCart();
  const cartId = call.actions[0]!.id;
  assert.equal((await post(`/actions/${cartId}/approve`, { order: "soon" })).status, 400);
  const res = (await (await post(`/actions/${cartId}/approve`, { order: "now" })).json()) as { status: string; order: OrderCard };
  assert.equal(res.status, "approved");
  assert.equal(res.order.type, "order");
  assert.equal(res.order.needsApproval, true);
  assert.equal(res.order.order.status, "scheduled");
  assert.equal(res.order.order.scheduledFor, undefined);
  assert.equal(res.order.order.cart.total, 196); // case01 cart
  assert.equal((await post(`/actions/${cartId}/approve`, { order: "now" })).status, 409); // one order per cart

  // the order card joins its call, so the feed shows it
  const after = (await (await fetch(`${base}/calls/${call.callId}`)).json()) as CallResult;
  assert.deepEqual(after.actions.map((a) => a.type), ["cart", "advance", "order"]);

  const placed = (await (await post(`/actions/${res.order.id}/approve`)).json()) as { status: string; order: OrderCard["order"] };
  assert.equal(placed.status, "approved");
  assert.equal(placed.order.status, "placed");
  assert.equal(placed.order.cart.platform, "mock");
  assert.match(placed.order.orderId ?? "", /^mock-/);
  const again = (await (await post(`/actions/${res.order.id}/approve`)).json()) as { order: OrderCard["order"] };
  assert.equal(again.order.orderId, placed.order.orderId); // approving twice doesn't order twice

  // a time: confirmed, but placed later by runDue; the time is stored in UTC
  const later = await newCart();
  const sched = (await (await post(`/actions/${later.actions[0]!.id}/approve`, { order: "2026-11-23T08:00:00+05:30" })).json()) as { order: OrderCard };
  assert.equal(sched.order.order.scheduledFor, "2026-11-23T02:30:00.000Z");
  const confirmed = (await (await post(`/actions/${sched.order.id}/approve`)).json()) as { status: string; order: OrderCard["order"] };
  assert.deepEqual([confirmed.status, confirmed.order.status], ["approved", "scheduled"]);
});
