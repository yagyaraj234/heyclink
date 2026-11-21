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
  const { id, cookCode, ownerToken } = (await (await before.post("/households", signup)).json()) as { id: string; cookCode: string; ownerToken: string };
  const first = (await (await before.post("/calls", { transcript: "pehli", householdId: id })).json()) as CallResult;
  const second = (await (await before.post("/calls", { transcript: "doosri", householdId: id })).json()) as CallResult;
  const [cart, advance] = first.actions;
  const auth = { method: "POST", headers: { authorization: "Bearer " + ownerToken } };
  await fetch(before.base + `/actions/${cart!.id}/approve`, auth);
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
  assert.deepEqual(await (await fetch(after.base + `/actions/${advance!.id}/approve`, auth)).json(), {
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
  type OrderCard = Extract<ActionCard, { type: "order" }> & { order: { cart: { reviewId: string } } };
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

  const placed = (await (await post(`/actions/${res.order.id}/approve`, { reviewId: res.order.order.cart.reviewId })).json()) as { status: string; order: OrderCard["order"] };
  assert.equal(placed.status, "approved");
  assert.equal(placed.order.status, "placed");
  assert.equal(placed.order.cart.platform, "mock");
  assert.match(placed.order.orderId ?? "", /^mock-/);
  const again = (await (await post(`/actions/${res.order.id}/approve`, { reviewId: res.order.order.cart.reviewId })).json()) as { order: OrderCard["order"] };
  assert.equal(again.order.orderId, placed.order.orderId); // approving twice doesn't order twice

  // a time: confirmed, but placed later by runDue; the time is stored in UTC
  const later = await newCart();
  const sched = (await (await post(`/actions/${later.actions[0]!.id}/approve`, { order: "2026-11-23T08:00:00+05:30" })).json()) as { order: OrderCard };
  assert.equal(sched.order.order.scheduledFor, "2026-11-23T02:30:00.000Z");
  const confirmed = (await (await post(`/actions/${sched.order.id}/approve`, { reviewId: sched.order.order.cart.reviewId })).json()) as { status: string; order: OrderCard["order"] };
  assert.deepEqual([confirmed.status, confirmed.order.status], ["approved", "scheduled"]);
});

test("GET /households/:id/actions lists cards outside any call, newest first, with status and time", async (t) => {
  const { base, post, close } = await serve(fakeStt(), { llm: mealLlm });
  t.after(close);
  const feed = async () => (await (await fetch(`${base}/households/h1/actions`)).json()) as { card: ActionCard; status: string; at: string }[];
  assert.deepEqual(await feed(), []);

  const first = (await (await post("/households/h1/meal-plan", { date: "2026-11-22" })).json()) as ActionCard;
  const { cart } = (await (await post(`/actions/${first.id}/answer`, { option: "cook" })).json()) as { cart: ActionCard };
  await post("/calls", { transcript: case01.transcript, householdId: "h1" }); // call cards stay in GET /calls
  const second = (await (await post("/households/h1/meal-plan", { date: "2026-11-23" })).json()) as ActionCard;
  await post(`/actions/${cart.id}/approve`);

  const list = await feed();
  assert.deepEqual(list.map((a) => [a.card.id, a.status]), [[second.id, "pending"], [cart.id, "approved"], [first.id, "answered"]]);
  assert.deepEqual(list[1]!.card, cart);
  const times = list.map((a) => Date.parse(a.at));
  assert.ok(times.every((ms, i) => !Number.isNaN(ms) && (i === 0 || ms <= times[i - 1]!)));

  assert.equal((await fetch(`${base}/households/nope/actions`)).status, 404);
});

test("cook clarifies excess onions while safe packs reach the owner immediately", async (t) => {
  const groceries: Extraction["groceries"] = [
    { raw: "onions", item: "onion", qty: 1.5, unit: "kg", confidence: 1 },
    { raw: "more onions", item: "onion", qty: 1, unit: "kg", confidence: 1 },
  ];
  const { post, close } = await serve(fakeStt(), { llm: llmReplying({ groceries, notes: [] }) });
  t.after(close);
  const call = await (await post("/calls", { householdId: "h1", transcript: "onions" })).json();
  assert.deepEqual(call.actions.map((a: ActionCard) => a.type), ["cart", "question"]);
  const [cart, question] = call.actions;
  assert.equal(cart.cart.total, 66);
  assert.deepEqual(question.options, ["Add 500 g", "Skip"]);
  assert.equal(question.prompt.options.length, 2);
  const response = await post(`/actions/${question.id}/answer`, { option: question.options[0] });
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.cart.cart.total, 88);
  assert.deepEqual(accepted.cart.cart.held, []);
});

test("an owner edits the cart, reviews its new bill, and confirms exactly that order", async (t) => {
  const { post, close } = await serve();
  t.after(close);
  const call = await (await post("/calls", { transcript: case01.transcript, householdId: "h1" })).json();
  const original = call.actions[0];
  assert.equal(typeof original.cart.reviewId, "string");
  const edit = { reviewId: original.cart.reviewId, edits: [{ index: 0, qty: 1, unit: "kg" }, { index: 1, qty: 0, unit: "bunch" }] };
  const edited = await post(`/actions/${original.id}/review`, edit);
  assert.equal(edited.status, 200);
  const { cart } = await edited.json();
  assert.equal(cart.cart.total, 100);
  assert.deepEqual(cart.cart.lines.map((l: {item: string}) => l.item), ["atta", "milk"]);
  assert.equal((await post(`/actions/${original.id}/approve`, { order: "now", reviewId: original.cart.reviewId })).status, 409);
  const response = await post(`/actions/${cart.id}/approve`, { order: "now", reviewId: cart.cart.reviewId });
  const { order } = await response.json();
  assert.equal((await post(`/actions/${order.id}/approve`, {})).status, 409);
  assert.equal((await post(`/actions/${order.id}/approve`, { reviewId: original.cart.reviewId })).status, 409);
  assert.equal((await (await post(`/actions/${order.id}/approve`, { reviewId: cart.cart.reviewId })).json()).order.status, "placed");
});

test("a clarification that would introduce bulk asks for a safe quantity instead", async (t) => {
  const { post, close } = await serve(fakeStt(), { llm: llmReplying({ groceries: [
    { item: "onion", raw: "onion", qty: 5, unit: "kg", confidence: 0.3 },
  ], notes: [] }) });
  t.after(close);
  const call = await (await post("/calls", { householdId: "h1", transcript: "onion" })).json();
  const [question] = call.actions;
  const reply = await post(`/actions/${question.id}/answer`, { option: "Yes, add it" });
  assert.equal(reply.status, 422);
  const { question: next } = await reply.json();
  assert.deepEqual(next.options, ["Add 500 g", "Skip"]);
  const fixed = await (await post(`/actions/${next.id}/answer`, { option: "Add 500 g" })).json();
  assert.equal(fixed.cart.cart.total, 22);
});

test("a spoken cook reply resolves only an explicit choice and leaves unclear answers pending", async (t) => {
  let text = "maybe";
  const stt: Stt = { transcribe: async () => ({ text, lang: "hi", provider: "fake" }) };
  const { base, post, close } = await serve(stt, { llm: llmReplying({ groceries: [
    { raw: "thoda methi", item: "methi", qty: 1, unit: "bunch", confidence: 0.3 },
  ], notes: [] }) });
  t.after(close);
  const call = await (await post("/calls", { householdId: "h1", transcript: "methi" })).json();
  const url = `${base}/actions/${call.actions[0].id}/answer`;
  const speak = () => fetch(url, {method: "POST", headers: {"content-type": "audio/mp4"}, body: "recording"});
  assert.equal((await speak()).status, 422);
  text = "हाँ।";
  const response = await speak();
  assert.equal(response.status, 200);
  assert.equal((await response.json()).cart.cart.total, 18);
});

test("choosing a meal plan with a bulk ingredient asks the cook and rebuilds its standalone cart", async (t) => {
  const llm: Llm = { json: async <T>() => ({
    cook: { meals: [{ slot: "lunch", dish: "Roti", macros: mealMacros, steps: ["Knead"], ingredients: [{ item: "atta", qty: 8, unit: "kg" }] }] },
    order: { meals: [] },
  }) as T };
  const { base, post, close } = await serve(fakeStt(), { llm });
  t.after(close);
  const meal = await (await post("/households/h1/meal-plan")).json();
  const reply = await (await post(`/actions/${meal.id}/answer`, { option: "cook" })).json();
  assert.equal(reply.cart.cart.lines.length, 0);
  const feed = await (await fetch(base + "/households/h1/actions")).json();
  const entry = feed.find((e: {card: ActionCard}) => e.card.type === "question");
  assert.ok(entry, "cook must be able to correct the ingredient quantity");
  const answered = await (await post(`/actions/${entry.card.id}/answer`, { option: "Add 1 kg" })).json();
  assert.equal(answered.cart.id, reply.cart.id);
  assert.equal(answered.cart.cart.total, 66);
});

test("household signup gives only the owner a private connection credential", async (t) => {
  const { post, base, close } = await serve();
  t.after(close);
  const owner = await (await post("/households", signup)).json();
  assert.match(owner.ownerToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(owner.instamartAvailable, false);
  const cook = await (await post("/join", { code: owner.cookCode })).json();
  const publicHouse = await (await fetch(base + "/households/" + owner.id)).json();
  assert.ok(!("ownerToken" in cook) && !("ownerToken" in publicHouse));
});

test('owner receives a cart-ready push for a cook call without leaking the device token', async (t) => {
  const store = openStore();
  const {post, base, close} = await serve(fakeStt(), {store});
  t.after(close);
  const owner = await (await post('/households', signup)).json();
  const path = '/households/' + owner.id + '/alerts';
  const token = 'ExponentPushToken[test-device-123]';
  assert.equal((await post(path, {token})).status, 403);
  const register = await fetch(base + path, {method: 'POST', headers: {'content-type':'application/json', authorization:'Bearer ' + owner.ownerToken}, body: JSON.stringify({token})});
  assert.equal(register.status, 204);
  const call = await (await post('/calls', {householdId: owner.id, transcript: case01.transcript})).json();
  const {runDue} = await import('./actions/orders.ts');
  const {mockSwiggy} = await import('./actions/swiggy.ts');
  const pushes: unknown[] = [];
  const push = async (device: string, cart: string, kind: string) => {pushes.push([device, cart, kind]);};
  await runDue(new Date(), store, mockSwiggy, push);
  await runDue(new Date(), store, mockSwiggy, push);
  assert.deepEqual(pushes, [[token, call.actions[0].id, 'ready']]);
  assert.ok(!(await (await fetch(base + '/households/' + owner.id)).text()).includes(token));
});

test('a single requested reminder stops after owner marks the purchase; delivery remains visible to the cook', async (t) => {
  const store = openStore();
  const {post, base, close} = await serve(fakeStt(), {store});
  t.after(close);
  const owner = await (await post('/households', signup)).json();
  const send = (path: string, body: object) => fetch(base + path, {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer ' + owner.ownerToken},body:JSON.stringify(body)});
  await send('/households/' + owner.id + '/alerts', {token:'ExpoPushToken[phone]'});
  const call = await (await post('/calls', {householdId: owner.id, transcript:case01.transcript})).json();
  const cartId = call.actions[0].id;
  const path = '/actions/' + cartId + '/tracking';
  const tomorrow = new Date(Date.now() + 86400_000);
  assert.equal((await send(path, {remindAt:tomorrow.toISOString()})).status, 200);
  assert.equal((await post(path, {state:'ordered'})).status, 403);
  assert.equal((await send(path, {state:'delivered'})).status, 409);
  assert.equal((await send(path, {state:'ordered', reviewId: call.actions[0].cart.reviewId})).status, 200);
  assert.equal((await send(path, {state:'ordered', reviewId: call.actions[0].cart.reviewId})).status, 200);
  assert.equal((await send(path, {state:'delivered'})).status, 200);
  const {runDue} = await import('./actions/orders.ts');
  const {mockSwiggy} = await import('./actions/swiggy.ts');
  const pushes: string[] = [];
  await runDue(tomorrow, store, mockSwiggy, async (_,__,kind) => { pushes.push(kind); });
  assert.deepEqual(pushes, []);
  const detail = await (await fetch(base + '/calls/' + call.callId)).json();
  assert.equal(detail.tracking[cartId].state,'delivered');
  const household = await (await fetch(base + '/households/' + owner.id)).json();
  assert.equal(household.history.length,1);
});

test('the next cook request shows how long the previous delivered quantity lasted', async (t) => {
  const store = openStore();
  const llm = llmReplying({notes:[], groceries:[{item:"onion",raw:"pyaaz",unit:"kg",qty:1,confidence:1}]});
  const {post, close} = await serve(fakeStt(), {store,llm});
  t.after(close);
  const delivered = {id:'onion-delivery', type:'cart', needsApproval:false, cart:{platform:'mock',total:44,lines:[
    {item:'onion',qty:1,unit:'kg',price:44,searchUrl:''}
  ]}} satisfies ActionCard;
  store.addAction({householdId:'h1', done:true, card:delivered,
    tracking:{state:'delivered',deliveredAt:'2026-01-01T10:00:00.000Z'}});
  const extraction = {groceries:[],notes:[],stockouts:['onion']};
  const empty: CallResult = {callId:'recorded-note',transcript:{text:'pyaaz khatam',lang:'hi',provider:'fake'},actions:[],
    timings:{totalMs:0,sttMs:0,extractMs:0,planMs:0},extraction};
  store.addCall(empty,'h1','2026-01-06T10:00:00.000Z');
  store.addCall({...empty,callId:'repeated-note'},'h1','2026-01-07T10:00:00.000Z');
  const call = await (await post('/calls',{householdId:'h1',transcript:case01.transcript})).json();
  assert.deepEqual(call.usage, [{item:'onion',qty:1,unit:'kg',days:5,samples:1}]);
});

test('manual purchase requires the owner to confirm the same cart revision they reviewed', async (t) => {
  const store = openStore();
  const {post, base, close} = await serve(fakeStt(), {store});
  t.after(close);
  const owner = await (await post('/households', signup)).json();
  const cart = {platform:'mock',total:22,lines:[{item:'onion',qty:500,unit:'g',price:22,searchUrl:''}],reviewId:'v2'} as const;
  store.addAction({householdId:owner.id,done:false,card:{type:'cart',id:'updated',needsApproval:true,cart:{...cart,lines:[...cart.lines]}}});
  const purchase = (reviewId: string) => fetch(base+'/actions/updated/tracking', {method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+owner.ownerToken},body:JSON.stringify({state:'ordered',reviewId})});
  assert.equal((await purchase('v1')).status,409);
  assert.equal((await purchase('v2')).status,200);
});

test('only the household owner can approve purchases after signup', async (t) => {
  const {post, base, close} = await serve();
  t.after(close);
  const owner = await (await post('/households', signup)).json();
  const other = await (await post('/households', signup)).json();
  const call = await (await post('/calls', {householdId:owner.id,transcript:case01.transcript})).json();
  const path = '/actions/' + call.actions[0].id + '/approve';
  assert.equal((await post(path)).status,403);
  const approve = (token: string) => fetch(base + path, {method:'POST',headers:{authorization:'Bearer '+token}});
  assert.equal((await approve(other.ownerToken)).status,403);
  assert.equal((await approve(owner.ownerToken)).status,200);
});

test("removing the last item leaves the cart empty and pending until a cook clarification adds an item", async (t) => {
  const groceries: Extraction["groceries"] = [
    { raw: "onion", item: "onion", qty: 500, unit: "g", confidence: 1 },
    { raw: "methi", item: "methi", qty: 1, unit: "bunch", confidence: 0.3 },
  ];
  const { post, close } = await serve(fakeStt(), { llm: llmReplying({ groceries, notes: [] }) });
  t.after(close);
  const call = await (await post("/calls", { householdId: "h1", transcript: "onion and methi" })).json();
  const [cart, question] = call.actions;
  const edited = await post(`/actions/${cart.id}/review`, { reviewId: cart.cart.reviewId, edits: [{ index: 0, qty: 0, unit: "g" }] });
  assert.equal(edited.status, 200);
  const empty = (await edited.json()).cart.cart;
  assert.deepEqual([empty.lines, empty.total], [[], 0]);
  const approve = `/actions/${cart.id}/approve`;
  assert.equal((await post(approve, { reviewId: empty.reviewId })).status, 409);
  assert.equal((await post(approve, { reviewId: empty.reviewId, order: "now" })).status, 409);
  const answered = await (await post(`/actions/${question.id}/answer`, { option: "Yes, add it" })).json();
  assert.equal(answered.cart.id, cart.id);
  assert.equal(answered.cart.cart.total, 18);
});

function requestHandoff(base:string, card:Extract<ActionCard,{type:"cart"}>, ownerToken:string, reviewId=(card.cart as {reviewId?:string}).reviewId) {
  return fetch(base+"/actions/"+card.id+"/instamart", {method:"POST",headers:{authorization:"Bearer "+ownerToken,"content-type":"application/json"},body:JSON.stringify({reviewId})});
}

test("only the signed-up owner can open a cart for an Instamart OAuth session", async (t) => {
  const store=openStore();
  const { post, base, close } = await serve(undefined, {store,
    instamart: { origin: "https://kitchen.example", clientId: "kitchen" },
  });
  t.after(close);
  const owner = await (await post("/households", signup)).json();
  const other = await (await post("/households", signup)).json();
  assert.equal(owner.instamartAvailable, true);
  const call = (await (await post("/calls", { householdId: owner.id, transcript: case01.transcript })).json()) as CallResult;
  const card = call.actions.find((a) => a.type === "cart")!;
  const path = `/actions/${card.id}/instamart`;
  assert.equal((await post(path)).status, 403);
  const open = (key:string) => requestHandoff(base, card, key);
  // Older stored carts might already carry an owner-review marker from the cart lane.
  const saved=store.action(card.id)!;
  assert.ok(saved.card.type==="cart");
  Object.assign(saved.card.cart,{reviewId:"current-review"});
  store.saveAction(saved);
  assert.equal((await requestHandoff(base,card,owner.ownerToken,"outdated")).status,409);
  Object.assign(card.cart,{reviewId:"current-review"});
  assert.equal((await open(other.ownerToken)).status, 403);
  const { url } = await (await open(owner.ownerToken)).json();
  const link = new URL(url);
  assert.equal(link.origin, "https://kitchen.example");
  const begin = () =>
    fetch(base + "/instamart/open", {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ ticket: link.hash.slice(1) }),
    });
  const start = await begin();
  const auth = new URL(start.headers.get("location")!);
  assert.equal(auth.origin + auth.pathname, "https://mcp.swiggy.com/auth/authorize");
  assert.equal(auth.searchParams.get("code_challenge_method"), "S256");
  assert.equal(auth.searchParams.get("redirect_uri"), "https://kitchen.example/instamart/callback");
  assert.ok(auth.searchParams.get("state"));
  assert.equal((await begin()).status, 410);
  assert.equal((await fetch(base + "/instamart/callback?code=wrong&state=wrong")).status, 403);
});

test("owner picks a real pack and sees the full Instamart bill before opening Swiggy", async (t) => {
  const existing = {
    spinId: "spin-t",
    skuId: "sku-t",
    itemName: "Tomato",
    itemVariant: "500 g",
    quantity: 1,
    discountedFinalPrice: 20,
    isInStockAndAvailable: true,
  };
  const onion = {
    spinId: "spin-o",
    skuId: "sku-o",
    itemName: "Onion",
    itemVariant: "500 g",
    quantity: 1,
    discountedFinalPrice: 22,
    isInStockAndAvailable: true,
  };
  let cartItems = [existing];
  let payable = "₹52";
  let readGate: (() => Promise<void>) | undefined;
  const invoice = () => ({
    items: cartItems,
    cartTotalAmount: payable,
    selectedAddressDetails: { id: "home", address: "House 7" },
    billBreakdown: { lineItems: [{ label: "Delivery fee", value: "₹10" }], toPay: { label: "To pay", value: payable } },
  });
  const methods: string[] = [];
  const network: typeof fetch = async (url, init) => {
    const msg = JSON.parse(String(init?.body));
    if (String(url).endsWith("/auth/token")) {
      assert.equal(msg.code, "owner-code");
      assert.match(msg.code_verifier, /^[\w-]{43}$/);
      return Response.json({ access_token: "test-session", expires_in: 3600 });
    }
    assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer test-session");
    if (msg.method === "initialize")
      return Response.json({
        jsonrpc: "2.0",
        id: msg.id,
        result: { protocolVersion: "2025-03-26", capabilities: { tools: {} } },
      });
    if (msg.method === "notifications/initialized") return new Response(null, { status: 202 });
    const { name, arguments: args } = msg.params;
    methods.push(name);
    let data;
    if (name === "get_addresses")
      data = { addresses: [{ id: "home", addressLine: "House 7" }], pagination: { hasMore: false } };
    else if (name === "get_cart") {
      if (readGate) await readGate();
      data = invoice();
    } else if (name === "search_products")
      data = {
        products: [
          {
            inStock: true,
            isAvail: true,
            displayName: "Onion",
            variations: [
              {
                skuId: "sku-o",
                spinId: "spin-o",
                displayName: "Fresh onion",
                quantityDescription: "500 g",
                isInStockAndAvailable: true,
                price: { offerPrice: 22 },
                sla: { value: "12", unit: "min" },
              },
              {
                skuId: "bulk",
                spinId: "bulk",
                displayName: "Wholesale onion",
                quantityDescription: "5 kg",
                isInStockAndAvailable: true,
                price: { offerPrice: 180 },
              },
              {
                skuId: "crate",
                spinId: "crate",
                displayName: "Commercial crate",
                quantityDescription: "1 pack",
                isInStockAndAvailable: true,
                price: { offerPrice: 800 },
              },
            ],
          },
          {
            displayName: "Onion Powder",
            inStock: true,
            isAvail: true,
            variations: [
              {
                skuId: "wrong",
                spinId: "wrong",
                displayName: "Seasoning",
                quantityDescription: "500 g",
                isInStockAndAvailable: true,
                price: { offerPrice: 25 },
              },
            ],
          },
        ],
      };
    else if (name === "update_cart") {
      assert.equal(args.selectedAddressId, "home");
      assert.deepEqual(args.items, [
        { spinId: "spin-t", skuId: "sku-t", quantity: 1 },
        { spinId: "spin-o", skuId: "sku-o", quantity: 1 },
      ]);
      cartItems = [existing, onion];
      data = invoice();
    } else throw Error("unexpected Swiggy tool " + name);
    return Response.json({ jsonrpc: "2.0", id: msg.id, result: { structuredContent: { success: true, data } } });
  };
  const { post, base, close } = await serve(undefined, {
    instamart: { origin: "https://kitchen.example", clientId: "kitchen", network },
    llm: llmReplying({
      groceries: [
        { item: "onion", raw: "one packet onion", qty: 1, unit: "packet", confidence: 1 },
        { item: "methi", raw: "thoda methi", qty: 1, unit: "bunch", confidence: 0.4 },
      ],
      notes: [],
    }),
  });
  t.after(close);
  const owner = await (await post("/households", signup)).json();
  const call = (await (await post("/calls", { householdId: owner.id, transcript: "500 g onion" })).json()) as CallResult;
  const card = call.actions.find((a) => a.type === "cart")!;
  const handoff = await requestHandoff(base, card, owner.ownerToken);
  const ticket = new URL((await handoff.json()).url).hash.slice(1);
  const form = (path: string, body: Record<string, string>, cookie = "") =>
    fetch(base + path, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams(body),
    });
  const start = await form("/instamart/open", { ticket });
  const cookie = start.headers.get("set-cookie")!.split(";")[0]!;
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  const addresses = await (
    await fetch(base + "/instamart/callback?code=owner-code&state=" + state, { headers: { cookie } })
  ).text();
  assert.match(addresses, /House 7/);
  const csrf = addresses.match(/name="csrf" value="([^"]+)"/)![1]!;
  const choices = await (await form("/instamart/variants", { address: "home", csrf }, cookie)).text();
  assert.match(choices, /Fresh onion/);
  assert.doesNotMatch(choices, /Wholesale onion|Commercial crate|Seasoning/);
  assert.equal((await form("/instamart/prepare", { csrf: "wrong", line0: "sku-o" }, cookie)).status, 403);
  const rice = { ...existing, itemName: "Rice", skuId: "rice-sku", spinId: "rice-spin", itemVariant: "5 kg" };
  cartItems = [rice];
  const bulkBefore = await form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie);
  assert.equal(bulkBefore.status, 409);
  assert.match(await bulkBefore.text(), /household limit/);
  assert.equal(methods.includes("update_cart"), false);
  cartItems = [{ ...onion, quantity: 4 }];
  assert.equal((await form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie)).status, 409);
  assert.equal(methods.filter((name) => name === "update_cart").length, 0);
  cartItems = [{ ...onion, quantity: 4, itemVariant: "1 pack" }];
  assert.equal((await form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie)).status, 409);
  cartItems = [{ ...onion, spinId: "other", skuId: "other", itemVariant: "1 pack" }];
  assert.equal((await form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie)).status, 409);
  cartItems = [{ ...existing, itemVariant: "bulk crate" }];
  assert.equal((await form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie)).status, 409);
  // A different ingredient can fill its own household limit.
  cartItems = [{ ...existing, itemVariant: "2 kg" }];
  const nextCall = (await (await post("/calls", { householdId: owner.id, transcript: "onion" })).json()) as CallResult;
  const nextCart = nextCall.actions.find((c) => c.type === "cart")!;
  const another = await requestHandoff(base, nextCart, owner.ownerToken);
  const nextStart = await form("/instamart/open", { ticket: new URL((await another.json()).url).hash.slice(1) });
  const otherCookie = nextStart.headers.get("set-cookie")!.split(";")[0]!;
  const otherAddresses = await (await fetch(base + "/instamart/addresses", { headers: { cookie: otherCookie } })).text();
  const otherCsrf = otherAddresses.match(/name="csrf" value="([^"]+)"/)![1]!;
  await form("/instamart/variants", { csrf: otherCsrf, address: "home" }, otherCookie);
  const blocked = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  readGate = () => {
    readGate = undefined;
    blocked.resolve();
    return release.promise;
  };
  const firstPrepare = form("/instamart/prepare", { csrf, line0: "sku-o" }, cookie);
  await blocked.promise;
  const conflict = await form("/instamart/prepare", { csrf: otherCsrf, line0: "sku-o" }, otherCookie);
  release.resolve();
  const bill = await (await firstPrepare).text();
  assert.equal(conflict.status, 409);
  assert.match(bill, /Delivery fee/);
  assert.match(bill, /₹52/);
  assert.match(bill, /House 7/);
  assert.match(bill, /Tomato/);
  assert.match(bill, /12 min/);
  // Reopening the same app card must offer the existing retailer cart without adding again.
  const again = await requestHandoff(base, card, owner.ownerToken);
  const reopenTicket = new URL((await again.json()).url).hash.slice(1);
  // Owner can return without a browser session and without another OTP.
  const returning = await form("/instamart/open", { ticket: reopenTicket });
  const nextCookie = returning.headers.get("set-cookie")!.split(";")[0]!;
  assert.equal(returning.headers.get("location"), "/instamart/prepared");
  const existingBill = await fetch(base + "/instamart/prepared", { headers: { cookie: nextCookie } });
  assert.match(await existingBill.text(), /₹52/);
  // Another device changes the retailer cart after preparation, without changing the app card.
  cartItems = [onion, { ...rice, itemVariant: "1.5 kg" }, { ...rice, skuId: "rice-2", spinId: "rice-2", itemVariant: "1000 g" }];
  const bulkBill = await form("/instamart/continue", { csrf }, cookie);
  assert.equal(bulkBill.status, 409);
  assert.match(await bulkBill.text(), /rice.*2500 g.*household limit.*2000 g/i);
  const bulkReopen = await fetch(base + "/instamart/prepared", { headers: { cookie: nextCookie } });
  assert.equal(bulkReopen.status, 409);
  assert.equal(methods.filter(name => name === "update_cart").length, 1);
  cartItems = [onion, { ...existing, skuId: "sack", spinId: "sack", itemName: "Family value sack", itemVariant: "1 piece" }];
  const unknownPack = await form("/instamart/continue", { csrf }, cookie);
  assert.equal(unknownPack.status, 409);
  assert.match(await unknownPack.text(), /pack sizes/);
  cartItems = [{ ...existing, itemName: "Bread", skuId: "loaf", spinId: "loaf", itemVariant: "300 g", quantity: 4 }];
  const tooManyLoaves = await form("/instamart/continue", { csrf }, cookie);
  assert.equal(tooManyLoaves.status, 409);
  assert.match(await tooManyLoaves.text(), /bread.*4 pack.*household limit.*3 pack/i);
  cartItems = [existing, onion];
  payable = "₹56";
  const changed = await form("/instamart/continue", { csrf }, cookie);
  assert.equal(changed.status, 409);
  const updated = await changed.text();
  assert.match(updated, /₹56/);
  assert.equal((await form("/instamart/continue", { csrf }, cookie)).status, 403);
  const newCsrf = updated.match(/name="csrf" value="([^"]+)"/)![1]!;
  const checkout = await form("/instamart/continue", { csrf: newCsrf }, cookie);
  assert.equal(checkout.headers.get("location"), "https://www.swiggy.com/instamart");
  assert.match(checkout.headers.get("content-security-policy") ?? "", /form-action [^;]*https:\/\/www\.swiggy\.com/);
  assert.equal(methods.filter((name) => name === "update_cart").length, 1);
  const clarify = call.actions.find((a) => a.type === "question")!;
  assert.equal((await post("/actions/" + clarify.id + "/answer", { option: "Yes, add it" })).status, 200);
  assert.equal((await form("/instamart/continue", { csrf: newCsrf }, cookie)).status, 409);
  assert.equal((await fetch(base + "/instamart/prepared", { headers: { cookie: nextCookie } })).status, 409);
});

test("staging household connects to Swiggy staging", async (t) => {
  const registration: typeof fetch = async (url, init) => {
    assert.equal(String(url), "https://mcp-staging.swiggy.com/auth/register");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.redirect_uris, ["https://kitchen.example/instamart/callback"]);
    return Response.json({ client_id: "issued-id" });
  };
  const { post, base, close } = await serve(undefined, {
    instamart: { origin: "https://kitchen.example", network: registration, staging: true },
  });
  t.after(close);
  const owner = await (await post("/households", signup)).json();
  const call = (await (await post("/calls", { householdId: owner.id, transcript: case01.transcript })).json()) as CallResult;
  const cart = call.actions.find((c) => c.type === "cart")!;
  const response = await requestHandoff(base, cart, owner.ownerToken);
  const ticket = new URL((await response.json()).url).hash.slice(1);
  const login = await fetch(base + "/instamart/open", {
    method: "POST",
    redirect: "manual",
    body: new URLSearchParams({ ticket }),
  });
  const location = new URL(login.headers.get("location")!);
  assert.equal(location.hostname, "mcp-staging.swiggy.com");
  assert.equal(location.searchParams.get("client_id"), "issued-id");
});

test("confirmed household history uses the purchased pack, even when the cook requested less", async t => {
  const llm = llmReplying({notes: [], groceries: [{raw:"250 g onion", item:"onion", qty:250, unit:"g", confidence:1}]});
  const {post, base, close} = await serve(fakeStt(), {llm});
  t.after(close);
  const owner = await (await post("/households", signup)).json();
  const call = await (await post("/calls", {householdId:owner.id, transcript:"250 g onion"})).json();
  const card = call.actions[0];
  const purchase = () => fetch(base + "/actions/" + card.id + "/tracking", {
    method:"POST", headers:{"content-type":"application/json", authorization:"Bearer " + owner.ownerToken},
    body: JSON.stringify({state:"ordered", reviewId:card.cart.reviewId})
  });
  assert.equal((await purchase()).status, 200);
  assert.equal((await purchase()).status, 200);
  const household = await (await fetch(base + "/households/" + owner.id)).json();
  assert.deepEqual(household.history.map((entry: Household["history"][number]) => entry.lines), [
    [{item:"onion", qty:500, unit:"g"}]
  ]);
});
