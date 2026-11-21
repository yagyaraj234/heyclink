import type { Express, Request, RequestHandler } from "express";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import type { DecodedIdToken } from "firebase-admin/auth";
import type { Store } from "./store.ts";

export interface AuthConfig {
  projectId: string;
  inviteOrigin: string;
  iosAppId?: string;
  androidPackage?: string;
  androidFingerprints?: string[];
}

export function installAuth(app: Express, store: Store, config: AuthConfig, instamartAvailable: boolean) {
  const origin = new URL(config.inviteOrigin);
  if (origin.origin !== config.inviteOrigin || origin.protocol !== "https:") {
    throw new Error("INVITE_ORIGIN must be an HTTPS origin");
  }
  const appName = `kitchen-auth:${config.projectId}`;
  const firebase = getAuth(getApps().find((existing) => existing.name === appName) ??
    initializeApp({ projectId: config.projectId }, appName));
  const users = new WeakMap<Request, DecodedIdToken>();
  const roles = new WeakMap<Request, "owner" | "cook">();
  const user = (req: Request) => users.get(req)!;
  const role = (req: Request) => roles.get(req);
  const signedIn: RequestHandler = async (req, res, next) => {
    res.set("cache-control", "no-store");
    const token = /^Bearer (\S+)$/.exec(req.get("authorization") ?? "")?.[1];
    if (!token) return void res.status(401).json({ error: "Sign in to continue." });
    try {
      users.set(req, await firebase.verifyIdToken(token, true));
    } catch (error) {
      if (!(error instanceof Error && "code" in error) || ![
        "auth/argument-error", "auth/id-token-expired", "auth/id-token-revoked", "auth/invalid-id-token",
        "auth/user-disabled", "auth/user-not-found",
      ].includes(String(error.code))) {
        console.error("Firebase verification failed", error instanceof Error && "code" in error ? error.code : "unknown");
        return void res.status(503).json({ error: "Sign-in verification is temporarily unavailable." });
      }
      return void res.status(401).json({ error: "Sign in again to continue." });
    }
    next();
  };

  const member = (resolve: (req: Request) => Promise<{ id?: string; ownerOnly?: boolean }> | { id?: string; ownerOnly?: boolean }): RequestHandler =>
    async (req, res, next) => {
      const { id, ownerOnly } = await resolve(req);
      const access = id && await store.auth.role(id, user(req).uid);
      if (!access) return void res.status(404).json({ error: "Household or item unavailable." });
      if (ownerOnly && access !== "owner") return void res.status(403).json({ error: "Owner access required." });
      roles.set(req, access);
      next();
    };
  const id = (req: Request) => String(req.params.id ?? "");
  const household = (req: Request) => ({ id: id(req), ownerOnly: true });
  app.all("/calls", signedIn, member((req) => {
    const selected: unknown = req.query.householdId ?? req.body?.householdId;
    return { id: typeof selected === "string" ? selected : undefined };
  }));
  app.all("/calls/:id", signedIn, member(async (req) => ({ id: await store.callHousehold(id(req)) })));
  app.all("/actions/:id/:operation", signedIn, member(async (req) => {
    const entry = await store.action(id(req));
    return { id: entry?.householdId, ownerOnly: req.params.operation !== "answer" || entry?.card.type !== "question" };
  }));
  app.all("/households/:id", signedIn, member(household));
  app.all("/households/:id/actions", signedIn, member((req) => ({ id: id(req) })));
  app.all(["/households/:id/alerts", "/households/:id/meal-plan", "/households/:id/invites",
    "/households/:id/invites/cancel", "/households/:id/cook/revoke",
    "/households/:id/grocery-accounts/:retailer"], signedIn, member(household));
  app.all("/households/:id/reset", (_req, res) => void res.sendStatus(404));
  app.post(["/households", "/auth/claim"], signedIn);
  app.get("/households", signedIn, async (req, res) => void res.json(await store.auth.list(user(req).uid)));
  app.get("/auth/session", signedIn, (_req, res) => void res.json({ instamartAvailable }));

  app.get("/households/:id/invites", async (req, res) => void res.json(await store.auth.state(req.params.id)));
  app.post("/households/:id/invites", async (req, res) => {
    const invite = await store.auth.invite(req.params.id);
    if (!invite) return void res.status(409).json({ error: "Remove the current cook before inviting another." });
    res.status(201).json({ ...invite, url: `${origin.origin}/invite#${invite.code}` });
  });
  app.post("/households/:id/invites/cancel", async (req, res) => {
    await store.auth.revoke(req.params.id, false);
    res.sendStatus(204);
  });
  app.post("/households/:id/cook/revoke", async (req, res) => {
    await store.auth.revoke(req.params.id, true);
    res.sendStatus(204);
  });

  const join = (previewOnly: boolean): RequestHandler => async (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code.trim().replace(/[ -]/g, "").toUpperCase() : "";
    if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)) return void res.status(400).json({ error: "Enter a valid kitchen invite code." });
    const uid = user(req).uid;
    if (!await store.auth.allowJoinAttempt(uid)) return void res.status(429).json({ error: "Too many attempts. Try again later." });
    if (previewOnly) {
      const preview = await store.auth.preview(code);
      if (preview) return void res.json(preview);
    } else if (await store.auth.join(code, uid)) {
      return void res.status(201).json(await store.auth.list(uid));
    }
    res.status(404).json({ error: "This invite is unavailable. Ask the owner for a new one." });
  };
  app.post("/join/preview", signedIn, join(true));
  app.post("/join", signedIn, join(false));

  app.get("/invite", (_req, res) => {
    res.set({ "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'" })
      .type("html").send("<!doctype html><html lang=\"en\"><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>Kitchen invite</title><h1>Join a kitchen</h1><p>Open this link on a phone with Kitchen installed, or enter the code from your invitation in My Households.</p></html>");
  });
  if (config.iosAppId) app.get("/.well-known/apple-app-site-association", (_req, res) =>
    void res.json({ applinks: { details: [{ appIDs: [config.iosAppId], components: [{ "/": "/invite" }] }] } }));
  if (config.androidPackage && config.androidFingerprints?.length) app.get("/.well-known/assetlinks.json", (_req, res) =>
    void res.json([{ relation: ["delegate_permission/common.handle_all_urls"],
      target: { namespace: "android_app", package_name: config.androidPackage, sha256_cert_fingerprints: config.androidFingerprints } }]));

  return { user, role };
}
