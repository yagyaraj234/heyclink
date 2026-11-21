import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { createApp } from "../app.ts";
import type { Llm, Stt } from "../contracts.ts";
import { processCall } from "../pipeline/process.ts";
import fixture from "../../fixtures/household.json" with { type: "json" };
import type { Household } from "../contracts.ts";
import { openStore } from "./store.ts";

const projectId = "demo-kitchen";
const cookProfile = { name: "Lakshmi", lang: "hi", upiId: "lakshmi@example", monthlySalary: 5000 };
const stt: Stt = { async transcribe() { throw new Error("Expected text input"); } };
const llm: Llm = {
  async json<T>() {
    return { groceries: [], advance: { amount: 500, reason: null }, notes: [] } as T;
  },
};

function token(uid: string, expired = false) {
  const now = Math.floor(Date.now() / 1000);
  const segment = (data: object) => Buffer.from(JSON.stringify(data)).toString("base64url");
  return [segment({ alg: "none", typ: "JWT" }), segment({
    sub: uid, aud: projectId, iss: `https://securetoken.google.com/${projectId}`,
    iat: now - 60, auth_time: now - 60, exp: now + (expired ? -1 : 3600),
    ...(uid === "legacy-owner" && { phone_number: "+919876543210" }),
    firebase: { sign_in_provider: uid === "legacy-owner" ? "phone" : "google" },
  }), ""].join(".");
}

test("signed-in cook joins two households and can submit notes only to active memberships", async (t) => {
  // Fake the Firebase Auth emulator's account lookup over HTTP. The app uses the real Admin SDK.
  const firebase = createServer(async (req, res) => {
    assert.match(req.url ?? "", /accounts:lookup$/);
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const { localId } = JSON.parse(Buffer.concat(chunks).toString()) as { localId: string[] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ users: localId.map((uid) => ({ localId: uid, validSince: "1" })) }));
  }).listen(0, "127.0.0.1");
  await once(firebase, "listening");
  const previous = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${(firebase.address() as AddressInfo).port}`;
  t.after(() => {
    if (previous === undefined) delete process.env.FIREBASE_AUTH_EMULATOR_HOST;
    else process.env.FIREBASE_AUTH_EMULATOR_HOST = previous;
    firebase.close();
  });

  const store = await openStore();
  t.after(() => store.close({ drop: true }));
  const server = createApp({ store, processCall, stt, llm, auth: { projectId, inviteOrigin: "https://kitchen.example" } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function request(path: string, uid?: string, body?: object, expired = false) {
    return fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { ...(uid && { authorization: `Bearer ${token(uid, expired)}` }), "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
  }
  const signup = { owner: { name: "Priya" }, cook: cookProfile, approvalLimit: 500 };
  assert.equal((await request("/households", undefined, signup)).status, 401);
  assert.equal((await request("/calls?householdId=h1")).status, 401);
  assert.equal((await request("/calls?householdId=h1", "cook", undefined, true)).status, 401);

  const create = async (uid: string, name: string, location: string) => {
    const res = await request("/households", uid, { ...signup, name, location });
    assert.equal(res.status, 201, await res.clone().text());
    const { id } = await res.json();
    return String(id);
  };
  const first = await create("owner-a", "Sharma Home", "Indiranagar, Bengaluru");
  const second = await create("owner-b", "Rao Home", "Koramangala, Bengaluru");
  const invite = async (household: string, owner: string) => {
    const res = await request(`/households/${household}/invites`, owner, {});
    assert.equal(res.status, 201, await res.clone().text());
    return await res.json() as { code: string; url: string };
  };
  assert.equal((await request(`/households/${first}/invites`, "owner-b", {})).status, 404);
  const a = await invite(first, "owner-a");
  assert.match(a.url, /^https:\/\/kitchen\.example\/invite#/);
  const b = await invite(second, "owner-b");
  assert.notEqual(a.code, b.code);
  const preview = await request("/join/preview", "cook", { code: a.code });
  assert.deepEqual(await preview.json(), { name: "Sharma Home" });
  assert.deepEqual(await (await request("/households", "cook")).json(), []);
  assert.equal((await request("/join", "cook", { code: a.code })).status, 201);
  assert.equal((await request("/join", "other-cook", { code: a.code })).status, 404);
  assert.equal((await request(`/households/${second}/invites/cancel`, "owner-b", {})).status, 204);
  assert.equal((await request("/join", "cook", { code: b.code })).status, 404);
  const replacement = await invite(second, "owner-b");
  const concurrent = await Promise.all([
    request("/join", "cook", { code: replacement.code }),
    request("/join", "cook", { code: replacement.code }),
  ]);
  assert.deepEqual(concurrent.map(response => response.status).sort(), [201, 404]);
  const list = await (await request("/households", "cook")).json();
  assert.deepEqual(list, [
    { id: second, name: "Rao Home", location: "Koramangala, Bengaluru", role: "cook", lang: "hi" },
    { id: first, name: "Sharma Home", location: "Indiranagar, Bengaluru", role: "cook", lang: "hi" },
  ]);
  const note = { transcript: "paanch sau advance" };
  assert.equal((await request(`/calls?householdId=${first}`, "other-cook", note)).status, 404);
  const res = await request(`/calls?householdId=${first}`, "cook", note);
  assert.equal(res.status, 201, await res.clone().text());
  const call = await res.json();
  assert.deepEqual(call.actions, []);
  assert.equal((await request(`/calls/${call.callId}`, "owner-b")).status, 404);
  const ownerCall = await (await request(`/calls/${call.callId}`, "owner-a")).json();
  assert.equal((await request(`/actions/${ownerCall.actions[0].id}/approve`, "cook", {})).status, 403);
  assert.equal((await request(`/actions/${ownerCall.actions[0].id}/approve`, "owner-a", {})).status, 200);
  assert.equal((await request(`/households/${first}/cook/revoke`, "owner-a", {})).status, 204);
  assert.equal((await request(`/calls?householdId=${first}`, "cook", note)).status, 404);
  assert.equal((await request(`/calls?householdId=${second}`, "cook", note)).status, 201);
  const emptyCallId = "stored-call-without-cards";
  await store.addCall({ ...ownerCall, callId: emptyCallId, actions: [] }, second, new Date().toISOString());
  assert.equal((await request(`/calls/${emptyCallId}`, "cook")).status, 200);
  assert.equal((await request(`/calls/${emptyCallId}`, "owner-a")).status, 404);

  const legacy = { ...fixture, id: "legacy", owner: { name: "Legacy Owner", phone: "unverified" } } as Household;
  const claim = { householdId: legacy.id, ownerToken: "X".repeat(43), name: "Legacy Home", location: "Pune" };
  assert.equal(await store.addHousehold(legacy, "LEGACY", claim.ownerToken), true);
  assert.equal((await request("/auth/claim", "owner-a", claim)).status, 403);
  assert.equal((await request("/auth/claim", "legacy-owner", { ...claim, ownerToken: "Y".repeat(43) })).status, 404);
  assert.equal((await request("/auth/claim", "legacy-owner", claim)).status, 200);
  assert.equal((await request("/auth/claim", "legacy-owner", claim)).status, 200);
  assert.equal(await store.isOwner(legacy.id, "Bearer " + claim.ownerToken), false);
  assert.equal((await request(`/calls?householdId=${legacy.id}`, "legacy-owner")).status, 200);
});

const liveProject = process.env.FIREBASE_PROJECT_ID;
const liveToken = process.env.FIREBASE_TEST_ID_TOKEN;
test("Firebase verifies a real mobile ID token", { skip: process.env.LIVE !== "1" || !liveProject || !liveToken }, async (t) => {
  assert.ok(liveProject && liveToken);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, undefined);
  const store = await openStore();
  t.after(() => store.close({ drop: true }));
  const server = createApp({ store, processCall, stt, llm, auth: { projectId: liveProject, inviteOrigin: "https://kitchen.example" } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const res = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/session`, {
    headers: { authorization: "Bearer " + liveToken },
  });
  assert.equal(res.status, 200, await res.text());
});
