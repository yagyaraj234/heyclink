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
  const origin = "https://kitchen.example";
  const credentialKey = Buffer.alloc(32, 77);
  const instamartNetwork: typeof fetch = async (input, init) => {
    const rpc = JSON.parse(String(init?.body));
    if (String(input) === "https://mcp.swiggy.com/im") {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer swiggy-access");
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      const result = rpc.method === "initialize" ? { protocolVersion: "2025-03-26" } : {
        structuredContent: { success: true, data: { addresses: [{ id: "address-1", addressLine: "12 Market Street" }], pagination: { hasMore: false } } },
      };
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
    }
    assert.equal(String(input), "https://mcp.swiggy.com/auth/token");
    assert.equal(rpc.code, "swiggy-code");
    return Response.json({ access_token: "swiggy-access", refresh_token: "swiggy-refresh", expires_in: 3600 });
  };
  const zeptoNetwork: typeof fetch = async (input, init) => {
    assert.equal(String(input), "https://auth.zepto.co.in/token");
    assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded");
    const body = new URLSearchParams(String(init?.body));
    assert.equal(body.get("code"), "zepto-code");
    assert.equal(body.get("client_id"), "zepto-client");
    assert.equal(body.get("redirect_uri"), origin + "/zepto/callback");
    return Response.json({ access_token: "zepto-access", refresh_token: "zepto-refresh", expires_in: 3600 });
  };
  const server = createApp({
    store, processCall, stt, llm, auth: { projectId, inviteOrigin: origin },
    instamart: { origin, credentialKey, clientId: "swiggy-client", network: instamartNetwork },
    zepto: { origin, credentialKey, clientId: "zepto-client", network: zeptoNetwork },
  }).listen(0, "127.0.0.1");
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
  await t.test("only owners link grocery accounts, independently of a cart", async () => {
    const path = (id: string, retailer: string) => `/households/${id}/grocery-accounts/${retailer}`;
    const instamart = path(first, "instamart");
    const zepto = path(first, "zepto");
    const status = async (route: string, uid = "owner-a") => {
      const res = await request(route, uid);
      assert.equal(res.status, 200);
      return (await res.json()).status;
    };
    assert.equal((await request(instamart)).status, 401);
    assert.equal((await request(instamart, "cook", {})).status, 403);
    assert.equal((await request(zepto, "owner-b", {})).status, 404);
    assert.equal(await status(instamart), "available");
    assert.equal(await status(zepto), "available");

    async function begin(route: string, authorizeUrl: string, scope: string, redirect: string, code: string) {
      const start = await request(route, "owner-a", {});
      assert.equal(start.status, 200);
      const open = new URL((await start.json()).url);
      assert.equal(open.origin, origin);
      const response = await fetch(base + open.pathname, {
        method: "POST", body: new URLSearchParams({ ticket: open.hash.slice(1) }), redirect: "manual",
      });
      assert.equal(response.status, 303);
      const authorize = new URL(response.headers.get("location")!);
      assert.equal(authorize.origin + authorize.pathname, authorizeUrl);
      assert.equal(authorize.searchParams.get("scope"), scope);
      assert.equal(authorize.searchParams.get("redirect_uri"), origin + redirect);
      assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
      const callback = new URL(base + redirect);
      callback.searchParams.set("state", authorize.searchParams.get("state")!);
      callback.searchParams.set("code", code);
      return () => fetch(callback, { headers: { cookie: response.headers.get("set-cookie")!.split(";")[0]! } });
    }
    const swiggyCallback = await begin(instamart, "https://mcp.swiggy.com/auth/authorize", "mcp:tools", "/instamart/callback", "swiggy-code");
    const response = await swiggyCallback();
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Instamart connected/);
    assert.equal((await swiggyCallback()).status, 403);
    assert.equal(await status(instamart), "connected");
    assert.equal(await status(path(second, "instamart"), "owner-b"), "available");
    assert.equal(await status(zepto), "available");

    const zeptoCallback = await begin(zepto, "https://auth.zepto.co.in/authorize", "tools:read", "/zepto/callback", "zepto-code");
    assert.equal((await zeptoCallback()).status, 200);
    assert.equal(await status(zepto), "connected");
    const staleCallback = await begin(zepto, "https://auth.zepto.co.in/authorize", "tools:read", "/zepto/callback", "zepto-code");
    const disconnect = (route: string, uid: string) => fetch(base + route, {
      method: "DELETE", headers: { authorization: "Bearer " + token(uid) },
    });
    assert.equal((await disconnect(zepto, "cook")).status, 403);
    assert.equal((await disconnect(zepto, "owner-a")).status, 204);
    assert.equal((await staleCallback()).status, 409);
    assert.equal(await status(zepto), "available");
    assert.equal(await status(instamart), "connected");

    await store.addAction({
      householdId: first, done: false, card: {
        id: "grocery-review", type: "cart", needsApproval: true, cart: {
          lines: [{ item: "onion", qty: 500, unit: "g", price: 22, searchUrl: "https://www.swiggy.com/instamart" }],
          total: 22, platform: "instamart",
        },
      },
    });
    const start = await request("/actions/grocery-review/instamart", "owner-a", {});
    assert.equal(start.status, 200);
    const open = new URL((await start.json()).url);
    const review = await fetch(base + open.pathname, {
      method: "POST", body: new URLSearchParams({ ticket: open.hash.slice(1) }), redirect: "manual",
    });
    assert.equal(review.status, 303);
    assert.equal(review.headers.get("location"), "/instamart/addresses");
    const addresses = () => fetch(base + "/instamart/addresses", {
      headers: { cookie: review.headers.get("set-cookie")!.split(";")[0]! },
    });
    assert.match(await (await addresses()).text(), /12 Market Street/);
    assert.equal((await disconnect(instamart, "owner-a")).status, 204);
    assert.equal((await addresses()).status, 403);
  });

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

test("Zepto publishes the OAuth endpoints and scope used for grocery accounts", { skip: process.env.LIVE !== "1" }, async () => {
  const resource = await fetch("https://mcp.zepto.co.in/.well-known/oauth-protected-resource", { signal: AbortSignal.timeout(10_000) });
  assert.equal(resource.status, 200);
  const protectedResource = await resource.json();
  assert.equal(protectedResource.resource, "https://mcp.zepto.co.in");
  assert.ok(protectedResource.authorization_servers.includes("https://auth.zepto.co.in"));
  assert.ok(protectedResource.scopes_supported.includes("tools:read"));

  const authorizationServer = await fetch("https://auth.zepto.co.in/.well-known/oauth-authorization-server", { signal: AbortSignal.timeout(10_000) });
  assert.equal(authorizationServer.status, 200);
  const metadata = await authorizationServer.json();
  assert.equal(metadata.authorization_endpoint, "https://auth.zepto.co.in/authorize");
  assert.equal(metadata.token_endpoint, "https://auth.zepto.co.in/token");
  assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
  assert.ok(metadata.token_endpoint_auth_methods_supported.includes("none"));
});

const liveProject = process.env.FIREBASE_PROJECT_ID;
const liveToken = process.env.FIREBASE_TEST_ID_TOKEN;
const liveOwnerToken = process.env.FIREBASE_TEST_OWNER_ID_TOKEN;
test("Firebase verifies a real mobile ID token", { skip: process.env.LIVE !== "1" || !liveProject || !liveToken }, async (t) => {
  assert.ok(liveProject && liveToken);
  assert.equal(process.env.FIREBASE_AUTH_EMULATOR_HOST, undefined);
  const store = await openStore();
  t.after(() => store.close({ drop: true }));
  const server = createApp({ store, processCall, stt, llm, auth: { projectId: liveProject, inviteOrigin: "https://kitchen.example" } }).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  async function request(path: string, bearer: string, status: number, body?: object) {
    const response = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: "Bearer " + bearer, "content-type": "application/json" },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    assert.equal(response.status, status, path);
    return response;
  }
  await request("/auth/session", liveToken, 200);

  await t.test("one cook joins two households and loses access only to the revoked household", {
    skip: !liveOwnerToken,
  }, async () => {
    assert.ok(liveOwnerToken);
    const homes = [
      { name: "Rao Test Home", location: "Indiranagar, Bengaluru" },
      { name: "Sharma Test Home", location: "Koramangala, Bengaluru" },
    ];
    const ids = [];
    for (const home of homes) {
      const { id } = await (await request("/households", liveOwnerToken, 201, {
        ...home, owner: { name: "Test Owner" }, cook: cookProfile, approvalLimit: 500,
      })).json() as { id: string };
      const { code } = await (await request(`/households/${id}/invites`, liveOwnerToken, 201, {})).json() as { code: string };
      await request("/join", liveToken, 201, { code });
      await request("/join", liveToken, 404, { code });
      ids.push(id);
    }
    const list = await (await request("/households", liveToken, 200)).json() as { name: string; location: string; role: string }[];
    assert.deepEqual(list.map(({ name, location, role }) => ({ name, location, role })),
      homes.map(home => ({ ...home, role: "cook" })));

    const [first, second] = ids;
    const note = { transcript: "paanch sau advance" };
    const firstFeed = `/calls?householdId=${first}`;
    const secondFeed = `/calls?householdId=${second}`;
    await request(firstFeed, liveToken, 201, note);
    await request(secondFeed, liveToken, 201, note);
    const [call] = await (await request(firstFeed, liveOwnerToken, 200)).json() as { actions: { id: string; type: string }[] }[];
    const advance = call?.actions.find(action => action.type === "advance");
    assert.ok(advance);
    await request(`/actions/${advance.id}/approve`, liveToken, 403, {});
    await request(`/households/${first}/cook/revoke`, liveOwnerToken, 204, {});
    await request(firstFeed, liveToken, 404);
    await request(secondFeed, liveToken, 200);
  });
});
