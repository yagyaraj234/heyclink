import express from "express";
import type { Request, Response } from "express";
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { cartRevision as revision } from "./store.ts";
import type { Store, GroceryReceipt } from "./store.ts";
import { makeIntent, acceptAdjustments, reconcile } from "./instamart-intent.ts";
import type { InstamartIntent } from "./instamart-intent.ts";
import type { Cart } from "../contracts.ts";
import { connectInstamart, swiggyOrigin } from "./instamart-client.ts";
import type { Instamart, RetailCart } from "./instamart-client.ts";
import { packOption, checkedItems, sameGrocery } from "./instamart-packs.ts";
import type { PickedPack } from "./instamart-packs.ts";

export interface InstamartConfig {
  origin: string;
  clientId?: string;
  network?: typeof fetch;
  staging?: boolean;
  credentialKey?: Buffer;
}
const random = () => randomBytes(32).toString("base64url");
const CALLBACK = "/instamart/callback";
const lease = (s: Ticket) => "lease " + s.householdId;

interface Ticket {
  cartId: string;
  householdId: string;
  snapshot: string;
  until: number;
  key: string; // base64 key for this household’s sealed provider credential
}
interface Credential {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
}
function seal(key: Buffer, value: unknown) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
}
function unseal<T>(key: Buffer, value: string): T {
  const bytes = Buffer.from(value, "base64");
  const reader = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  reader.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([reader.update(bytes.subarray(28)), reader.final()]).toString("utf8"));
}
interface Session extends Ticket {
  cookie: string; // not stored: the row is found by its hash and sealed with a key derived from it
  state: string;
  verifier: string;
  csrf: string;
  token?: string;
  addresses?: string[];
  address?: string;
  options?: PickedPack[][];
  local?: string;
  bill?: string;
}
// Tickets and sessions live in instamart_state, so any instance can serve the next step. The database
// sees only a hash of each browser secret and a payload sealed with a key derived from that secret.
const rowKey = (secret: string) => createHmac("sha256", secret).update("instamart state v1").digest();
const credentialKey = (s: Ticket) => Buffer.from(s.key, "base64");

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const field = (s: Session) => `<input type="hidden" name="csrf" value="${s.csrf}">`;
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

async function invoice(
  s: Session,
  cart: RetailCart,
  intent: InstamartIntent | undefined,
  res: Response,
  save: (s: Session) => Promise<void>,
  { revisedCart, staging, publish }: {
    revisedCart?: Cart;
    staging?: boolean;
    publish?: (receipt: Omit<GroceryReceipt, "receiptId">) => Promise<void>;
  } = {},
) {
  const invoiceAddress = cart.selectedAddressDetails?.address ?? cart.selectedAddress;
  if (
    !Array.isArray(cart.items) ||
    !cart.billBreakdown?.toPay?.value ||
    !invoiceAddress ||
    !cart.items.length ||
    (cart.selectedAddressDetails?.id && s.address !== cart.selectedAddressDetails.id)
  ) {
    fail(409, "Swiggy could not confirm a bill and delivery address. Check your cart in Instamart.");
  }
  const requested = new Set(intent?.items.flatMap((i) => (i.added ? [i.added.item] : [])));
  checkedItems(cart.items, s.options, [], requested);
  const lines = reconcile(intent, cart);
  const warnings = [
    cart.addressWarning,
    cart.cartWarning?.message,
    ...(intent?.notes ?? []),
    ...(cart.unserviceableItems ?? []).map((i) => i.itemName + " is unavailable"),
  ].filter(Boolean);
  const rows = cart.items
    .map(
      (i) =>
        `<li>${escape(i.itemName)} · ${escape(i.quantity)} × ${escape(i.itemVariant)} · ₹${escape(i.discountedFinalPrice)} each${i.isInStockAndAvailable ? "" : " · unavailable"}</li>`,
    )
    .join("");
  const fees = cart.billBreakdown.lineItems.map((i) => `<li>${escape(i.label)} · ${escape(i.value)}</li>`).join("");
  const details = `<p>Deliver to ${escape(invoiceAddress)}</p><ul>${rows}</ul><ul>${fees}</ul><p><strong>To pay ${escape(cart.billBreakdown.toPay.value)}</strong></p>${warnings.map((w) => `<p>${escape(w)}</p>`).join("")}`;
  const changed = !!s.bill && s.bill !== details;
  s.bill = details;
  if (changed) s.csrf = random();
  await save(s);
  if (publish && !changed) {
    const eta = [
      ...new Set(
        intent?.items
          .filter((i) => i.added && i.quantity > i.prior)
          .map((i) => i.added?.eta)
          .filter(Boolean),
      ),
    ].join(", ");
    await publish({
      source: "instamart",
      lines,
      total: cart.billBreakdown.toPay.value,
      fees: cart.billBreakdown.lineItems,
      address: invoiceAddress,
      ...(eta && { eta }),
    });
    if (staging)
      return void page(res, "Staging review complete", "<p>This cart uses seeded inventory. No payment was taken.</p>");
    return void res.redirect(303, "https://www.swiggy.com/instamart");
  }
  if (changed) res.status(409);
  const revisedList = revisedCart
    ? `<h2>Updated household list</h2><ul>${revisedCart.lines.map(l => `<li>${escape(l.item)} · ${escape(l.qty)} ${escape(l.unit)}${l.brand ? ` · ${escape(l.brand)}` : ""}</li>`).join("")}</ul>
       <h2>Existing Instamart basket</h2><p>Kitchen updated the list after sending these packs to Instamart. Continue if you want to buy the basket below. To buy different packs, use the store links in Kitchen and record the purchase there.</p>`
    : "";
  page(
    res,
    changed ? "Cart changed. Review again" : "Review your Instamart bill",
    revisedList + details +
      `<p>Open the cart in the same Swiggy account to verify delivery time and pay.</p><form method="post" action="/instamart/continue">${field(s)}<button>${revisedCart ? "Continue with existing basket" : "Continue to Swiggy"}</button></form>`,
  );
}

function prune<T extends { until: number }>(map: Map<string, T>) {
  for (const [key, value] of map) if (value.until <= Date.now()) map.delete(key);
}

function page(res: Response, title: string, body: string) {
  res.type("html")
    .send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font:1rem/1.5 system-ui;max-width:38rem;margin:auto;padding:1.5rem;color:#173228}h1{font-size:1.5rem}button,select{font:inherit;padding:.6rem}button{margin-top:1rem}label{display:block;margin:.6rem 0}</style>
<main><h1>${title}</h1>${body}</main></html>`);
}

export function instamartRouter(config: InstamartConfig, store: Store, isAuthenticatedOwner?: (req: Request) => boolean) {
  if (isAuthenticatedOwner && config.credentialKey?.length !== 32) {
    throw new Error("INSTAMART_CREDENTIAL_KEY must be a 32-byte hex key when Firebase auth is enabled.");
  }
  const rowId = (secret: string) => createHash("sha256").update(config.credentialKey ? "firebase:" + secret : secret).digest("base64url");
  const { origin } = config;
  const provider = swiggyOrigin(config.staging);
  const host = new URL(origin);
  let registration: Promise<string> | undefined;
  async function getClientId(): Promise<string> {
    if (config.clientId) return config.clientId;
    registration ??= (async () => {
      // Every instance must use one client id: the token exchange may land on a different instance than authorize.
      const id = "client " + provider + " " + origin;
      const saved = await store.instamartState(id);
      if (saved) return saved;
      const response = await network(provider + "/auth/register", {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Household Kitchen",
          redirect_uris: [origin + CALLBACK],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
        }),
      });
      if (!response.ok) fail(502, "Could not register the Instamart callback. Verify Swiggy access.");
      const { client_id: clientId } = await response.json();
      if (typeof clientId !== "string" || !clientId) fail(502, "Swiggy returned no client identifier.");
      await store.claimInstamartState(id, clientId, Number.MAX_SAFE_INTEGER); // the first instance to register wins
      return (await store.instamartState(id))!;
    })().catch((error: unknown) => {
      registration = undefined;
      throw error;
    });
    return registration;
  }
  if (
    host.origin !== origin ||
    !(host.protocol === "https:" || (host.protocol === "http:" && host.hostname === "localhost"))
  ) {
    throw new Error("INSTAMART_PUBLIC_ORIGIN must be an HTTPS origin (or HTTP localhost)");
  }
  const linkId = (householdId: string) => provider + (config.credentialKey ? "/firebase/" : "/") + householdId;
  const router = express.Router();
  // Live provider connections, per instance; another instance reconnects from the session's token.
  const clients = new Map<string, { client: Instamart; until: number }>();
  async function clientOf(token: string, until: number) {
    prune(clients);
    const cached = clients.get(token);
    if (cached) return cached.client;
    const client = await connectInstamart(token, network, config.staging);
    clients.set(token, { client, until });
    return client;
  }
  const saveSession = async ({ cookie, ...s }: Session) =>
    store.saveInstamartState(rowId(cookie), seal(rowKey(cookie), s), s.until);
  const sessionOf = async (req: Request): Promise<Session | undefined> => {
    const cookie = /(?:^|;\s*)instamart_session=([\w-]{43})(?:;|$)/.exec(req.get("cookie") ?? "")?.[1];
    const sealed = cookie && (await store.instamartState(rowId(cookie)));
    return sealed ? { ...unseal<Omit<Session, "cookie">>(rowKey(cookie), sealed), cookie } : undefined;
  };

  router.post("/actions/:id/instamart", async (req, res) => {
    const entry = await store.action(req.params.id);
    if (!entry || !(isAuthenticatedOwner ? isAuthenticatedOwner(req) : await store.isOwner(entry.householdId, req.get("authorization")))) return void res.sendStatus(403);
    if (entry.done || entry.card.type !== "cart" || !entry.card.cart.lines.length)
      return void res.status(409).json({ error: "Review an open grocery cart first" });
    const { reviewId } = entry.card.cart as Cart & { reviewId?: string };
    if (reviewId && req.body?.reviewId !== reviewId) fail(409, "The grocery list changed. Review it again.");
    const ticket = random();
    const secret = config.credentialKey ?? req.get("authorization")!;
    const key = createHmac("sha256", secret)
      .update("instamart link v1 " + (config.credentialKey ? linkId(entry.householdId) : provider))
      .digest("base64");
    const until = Date.now() + 120_000;
    const value: Ticket = { cartId: entry.card.id, householdId: entry.householdId, snapshot: revision(entry.card.cart), key, until };
    await store.saveInstamartState(rowId(ticket), seal(rowKey(ticket), value), until);
    res.set("cache-control", "no-store").json({ url: origin + "/instamart/open#" + ticket });
  });
  router.use("/instamart", express.urlencoded({ extended: false, limit: "16kb" }), (_req, res, next) => {
    res.set({
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "content-security-policy":
        "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; form-action 'self' https://mcp.swiggy.com https://mcp-staging.swiggy.com https://www.swiggy.com; frame-ancestors 'none'; base-uri 'none'",
    });
    next();
  });
  router.get("/instamart/open", (_req, res) =>
    page(
      res,
      "Connect your Instamart account",
      '<form method="post"><input type="hidden" name="ticket"><button>Continue to Swiggy</button></form><script src="/instamart/open.js"></script>',
    ),
  );
  router.get("/instamart/open.js", (_req, res) =>
    res
      .type("js")
      .send(
        'document.forms[0].elements.ticket.value = location.hash.slice(1); history.replaceState(null, "", location.pathname);',
      ),
  );
  router.post("/instamart/open", async (req, res) => {
    const secret = typeof req.body.ticket === "string" ? req.body.ticket : "";
    const sealedTicket = secret && (await store.takeInstamartState(rowId(secret)));
    if (!sealedTicket) return void res.status(410).send("Link expired. Open Review with Instamart again.");
    const ticket = unseal<Ticket>(rowKey(secret), sealedTicket);
    await currentCart(ticket);
    const session: Session = {
      ...ticket,
      cookie: random(),
      until: Date.now() + 15 * 60_000,
      verifier: random(),
      state: random(),
      csrf: random(),
    };
    const prior = await sessionOf(req);
    if (prior?.token && prior.householdId === ticket.householdId) {
      session.token = prior.token;
      session.until = Math.min(session.until, prior.until);
      if (prior.cartId === ticket.cartId) {
        session.address = prior.address;
      }
    }
    const sealed = await store.linkedInstamart(linkId(ticket.householdId));
    if (!session.token && sealed) {
      let credential = unseal<Credential>(credentialKey(ticket), sealed);
      if (credential.expiresAt <= Date.now() + 60_000 && credential.refresh_token) {
        const renewed = await exchange({ grant_type: "refresh_token", refresh_token: credential.refresh_token });
        if (renewed) {
          credential = renewed;
          await store.saveInstamartLink(linkId(ticket.householdId), seal(credentialKey(ticket), credential));
        }
      }
      if (credential.expiresAt > Date.now() + 60_000) {
        try {
          session.until = Math.min(session.until, credential.expiresAt);
          await clientOf(credential.access_token, session.until);
          session.token = credential.access_token;
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 401)) throw error;
        }
      }
    }
    await saveSession(session);
    res.cookie("instamart_session", session.cookie, {
      httpOnly: true,
      sameSite: "lax",
      secure: host.protocol === "https:",
      path: "/instamart",
      maxAge: 15 * 60_000,
    });
    if (session.token)
      return void res.redirect(303, await store.instamartClaimed(session.cartId) ? "/instamart/prepared" : "/instamart/addresses");
    const params = new URLSearchParams({
      client_id: await getClientId(),
      redirect_uri: origin + CALLBACK,
      state: session.state,
      scope: "mcp:tools",
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(session.verifier).digest("base64url"),
    });
    res.redirect(303, provider + "/auth/authorize?" + params);
  });
  const network = config.network ?? fetch;
  async function exchange(payload: object): Promise<Credential | undefined> {
    const auth = await network(provider + "/auth/token", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, client_id: await getClientId() }),
    });
    if ([400, 401, 403].includes(auth.status)) return;
    if (!auth.ok) fail(502, "Swiggy sign-in is unavailable. Try again later.");
    const tokens = await auth.json();
    if (
      typeof tokens.access_token !== "string" ||
      !tokens.access_token ||
      !Number.isFinite(tokens.expires_in) ||
      tokens.expires_in <= 0
    )
      fail(502, "Swiggy sign-in failed.");
    return {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };
  }
  const currentCart = async (s: Ticket): Promise<Cart> => {
    const e = await store.action(s.cartId);
    if (!e || e.done || e.householdId !== s.householdId || e.card.type !== "cart")
      fail(409, "This cart changed. Reopen it from the app.");
    if (revision(e.card.cart) !== s.snapshot) fail(409, "This cart changed. Reopen it from the app.");
    return e.card.cart;
  };

  const formSession = async (req: Request) => {
    const s = await sessionOf(req);
    if (!s || !s.token || s.csrf !== req.body?.csrf) fail(403, "Review session expired. Reopen the cart from the app.");
    return s;
  };
  router.get(CALLBACK, async (req, res) => {
    const s = await sessionOf(req);
    if (!s || !s.state || req.query.state !== s.state || typeof req.query.code !== "string") return void res.sendStatus(403);
    await currentCart(s);
    const verifier = s.verifier;
    s.state = s.verifier = "";
    await saveSession(s); // state is single use, even if the exchange below fails
    const credential = await exchange({
      grant_type: "authorization_code",
      code: req.query.code,
      code_verifier: verifier,
      redirect_uri: origin + CALLBACK,
    });
    if (!credential) fail(401, "Swiggy login expired. Open Review with Instamart again.");
    s.until = Math.min(s.until, credential.expiresAt);
    await clientOf(credential.access_token, s.until);
    s.token = credential.access_token;
    await store.saveInstamartLink(linkId(s.householdId), seal(credentialKey(s), credential));
    await saveSession(s);
    res.redirect(303, await store.instamartClaimed(s.cartId) ? "/instamart/prepared" : "/instamart/addresses");
  });
  const readForReview = async (s: Session) => {
    const token = await store.beginInstamartReview(s.cartId, s.snapshot);
    const latest = await (await clientOf(s.token!, s.until)).cart();
    const local = await currentCart(s);
    if (!await store.isInstamartReviewCurrent(s.cartId, s.snapshot, token))
      fail(409, "A newer review is open. Review the latest bill.");
    const revisedCart = (await store.instamartClaimed(s.cartId)) === s.snapshot ? undefined : local;
    return { latest, token, revisedCart };
  };
  router.get("/instamart/prepared", async (req, res) => {
    const s = await sessionOf(req);
    if (!s?.token || !await store.instamartClaimed(s.cartId)) return void res.sendStatus(403);
    const { latest, revisedCart } = await readForReview(s);
    const intent = await store.instamartIntent(s.cartId);
    s.address = intent?.address;
    await invoice(s, latest, intent, res, saveSession, { revisedCart });
  });
  router.get("/instamart/addresses", async (req, res) => {
    const s = await sessionOf(req);
    if (!s?.token) return void res.sendStatus(403);
    const pageNumber = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return void res.sendStatus(400);
    const data = await (await clientOf(s.token, s.until)).addresses(pageNumber);
    s.addresses = data.addresses.map((a) => a.id);
    await saveSession(s);
    const addresses = data.addresses
      .map(
        (a) =>
          `<label><input required type="radio" name="address" value="${escape(a.id)}"> ${escape(a.addressLine)}</label>`,
      )
      .join("");
    page(
      res,
      "Choose a delivery address",
      `<form method="post" action="/instamart/variants">${field(s)}${addresses}${addresses ? "<button>Find grocery packs</button>" : "Add a delivery address in Swiggy."}</form>${data.pagination.hasMore ? `<a href="?page=${pageNumber + 1}">More addresses</a>` : ""}`,
    );
  });
  router.post("/instamart/variants", async (req, res) => {
    const s = await formSession(req);
    if (s.bill || (await store.instamartState(lease(s))) || (await store.instamartClaimed(s.cartId)))
      fail(409, "This cart was already prepared. Review it in Swiggy.");
    const address = req.body.address;
    if (!s.addresses?.includes(address)) fail(400, "Choose a listed address.");
    const cart = await currentCart(s);
    const client = await clientOf(s.token!, s.until);
    const options: PickedPack[][] = [];
    for (const line of cart.lines) {
      const query = [line.brand, line.item].filter(Boolean).join(" ").replaceAll("-", " ");
      const found = await client.search(address, query);
      options.push(
        found.products
          .filter((p) => p.inStock && p.isAvail && sameGrocery(line.item, p.displayName, p.brand))
          .flatMap((p) => p.variations)
          .filter((v) => v.displayName === v.quantityDescription || sameGrocery(line.item, v.displayName, v.brandName))
          .map((v) => packOption(line, v))
          .filter((v): v is PickedPack => !!v)
          .slice(0, 12),
      );
    }
    s.address = address;
    s.local = revision(cart);
    s.options = options;
    await saveSession(s);
    const picks = cart.lines
      .map(
        (l, i) =>
          `<fieldset><legend>${escape(l.item)} · ${escape(l.qty)} ${escape(l.unit)}</legend>${options[i]!.map((p) => `<label><input required type="radio" name="line${i}" value="${escape(p.variant.skuId)}"> ${escape(p.variant.displayName)} · ${p.count} × ${escape(p.variant.quantityDescription)} · ₹${escape(p.variant.price.offerPrice)} each</label>`).join("")}<label><input required type="radio" name="line${i}" value="">Leave this item out</label></fieldset>`,
      )
      .join("");
    page(
      res,
      "Choose grocery packs",
      `<form method="post" action="/instamart/prepare">${field(s)}${picks}<button>Add selected packs to my cart</button></form>`,
    );
  });
  router.post("/instamart/prepare", async (req, res) => {
    const s = await formSession(req);
    if (!s.options || !s.address || s.bill || revision(await currentCart(s)) !== s.local)
      fail(409, "Cart changed. Review from the app again.");
    const picked: PickedPack[] = [];
    const notes: string[] = [];
    for (const [i, options] of s.options.entries()) {
      const sku = req.body["line" + i];
      if (sku === "") {
        notes.push((await currentCart(s)).lines[i]!.item + " omitted");
        continue;
      }
      const p = options.find((p) => p.variant.skuId === sku);
      if (!p) fail(400, "Select a listed pack or leave the item out.");
      picked.push(p);
      if (p.variant.sla)
        notes.push(p.variant.displayName + " delivery estimate: " + p.variant.sla.value + " " + p.variant.sla.unit);
    }
    if (!picked.length) fail(400, "Choose at least one pack.");
    // A lease older than 2 minutes is presumed dead and can be taken; every provider call times out at 15 s.
    const holder = random();
    if (!(await store.claimInstamartState(lease(s), holder, Date.now() + 120_000)))
      fail(409, "Another household cart update is in progress. Retry after it finishes.");
    try {
      const client = await clientOf(s.token!, s.until);
      const before = await client.cart();
      if (!Array.isArray(before.items) || (before.items.length && before.selectedAddressDetails?.id !== s.address)) {
        fail(409, "Check the existing cart and selected address in Swiggy first.");
      }
      const items = checkedItems(before.items, s.options, picked);
      const intent = makeIntent(s.address, items, before.items, picked, notes);
      if (revision(await currentCart(s)) !== s.local || !await store.claimInstamart(s.cartId, s.local, intent))
        fail(409, "This cart changed or is already being prepared. Check Swiggy.");
      const cart = await client
        .update(s.address, items)
        .catch(() =>
          fail(
            502,
            "Instamart did not acknowledge the cart update. Reopen this grocery request to check the cart without adding the packs again.",
          ),
        );
      const adjusted = acceptAdjustments(intent, cart);
      reconcile(adjusted, cart);
      await store.saveInstamartIntent(s.cartId, adjusted);
      await invoice(s, cart, adjusted, res, saveSession);
    } finally {
      await store.takeInstamartState(lease(s), holder);
    }
  });
  router.post("/instamart/continue", async (req, res) => {
    const s = await formSession(req);
    if (!s.bill) fail(409, "Review your cart before continuing.");
    const { latest, token, revisedCart } = await readForReview(s);
    await invoice(s, latest, await store.instamartIntent(s.cartId), res, saveSession, {
      revisedCart,
      staging: config.staging,
      publish: (receipt) => store.saveInstamartReceipt(s.cartId, s.snapshot, receipt, token),
    });
  });
  return router;
}
