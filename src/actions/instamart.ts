import express from "express";
import type { Request, Response } from "express";
import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Store } from "./store.ts";
import type { Cart } from "../contracts.ts";
import { connectInstamart, swiggyOrigin } from "./instamart-client.ts";
import type { Instamart, RetailCart } from "./instamart-client.ts";
import { packOption, additions, sameGrocery } from "./instamart-packs.ts";
import type { PickedPack } from "./instamart-packs.ts";

export interface InstamartConfig {
  origin: string;
  clientId?: string;
  network?: typeof fetch;
  staging?: boolean;
}
const random = () => randomBytes(32).toString("base64url");
const CALLBACK = "/instamart/callback";

interface Ticket {
  cartId: string;
  householdId: string;
  snapshot: string;
  until: number;
  key: Buffer;
}
interface Credential {
  access_token: string;
  refresh_token?: string;
  expiresAt: number;
}
function seal(key: Buffer, value: Credential) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
}
function unseal(key: Buffer, value: string): Credential {
  const bytes = Buffer.from(value, "base64");
  const reader = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
  reader.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(Buffer.concat([reader.update(bytes.subarray(28)), reader.final()]).toString("utf8"));
}
interface Session extends Ticket {
  state: string;
  verifier: string;
  csrf: string;
  client?: Instamart;
  addresses?: Map<string, string>;
  address?: string;
  options?: PickedPack[][];
  local?: string;
  bill?: string;
  reviewNotes?: string[];
  busy?: boolean;
}

const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
const field = (s: Session) => `<input type="hidden" name="csrf" value="${s.csrf}">`;
function fail(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function invoice(s: Session, cart: RetailCart, res: Response, updated = false, staging = false) {
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
  const warnings = [
    cart.addressWarning,
    cart.cartWarning?.message,
    ...(s.reviewNotes ?? []),
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
  if (updated && !changed && staging)
    return void page(res, "Staging review complete", "<p>This cart uses seeded inventory. No payment was taken.</p>");
  if (updated && !changed) return void res.redirect(303, "https://www.swiggy.com/instamart");
  if (changed) {
    s.csrf = random();
    res.status(409);
  }
  page(
    res,
    changed ? "Cart changed. Review again" : "Review your Instamart bill",
    details +
      `<p>Open the cart in the same Swiggy account to verify delivery time and pay.</p><form method="post" action="/instamart/continue">${field(s)}<button>Continue to Swiggy</button></form>`,
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

export function instamartRouter(config: InstamartConfig, store: Store) {
  const { origin } = config;
  const provider = swiggyOrigin(config.staging);
  const host = new URL(origin);
  let registration: Promise<string> | undefined;
  async function getClientId(): Promise<string> {
    if (config.clientId) return config.clientId;
    registration ??= (async () => {
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
      const { client_id: id } = await response.json();
      if (typeof id !== "string" || !id) fail(502, "Swiggy returned no client identifier.");
      return id;
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
  const router = express.Router();
  const tickets = new Map<string, Ticket>();
  const sessions = new Map<string, Session>();
  const updating = new Set<string>();
  const sessionOf = (req: Request) => {
    const key = /(?:^|;\s*)instamart_session=([\w-]{43})(?:;|$)/.exec(req.get("cookie") ?? "")?.[1];
    const session = key && sessions.get(key);
    return session && session.until > Date.now() ? session : undefined;
  };

  router.post("/actions/:id/instamart", (req, res) => {
    const entry = store.action(req.params.id);
    if (!entry || !store.isOwner(entry.householdId, req.get("authorization"))) return void res.sendStatus(403);
    if (entry.done || entry.card.type !== "cart" || !entry.card.cart.lines.length)
      return void res.status(409).json({ error: "Review an open grocery cart first" });
    const { reviewId } = entry.card.cart as Cart & { reviewId?: string };
    if (reviewId && req.body?.reviewId !== reviewId) fail(409, "The grocery list changed. Review it again.");
    prune(tickets);
    const ticket = random();
    // The phone's owner capability unlocks the provider credential; the database contains only its verifier.
    const key = createHmac("sha256", req.get("authorization")!)
      .update("instamart link v1 " + provider)
      .digest();
    tickets.set(ticket, {
      cartId: entry.card.id,
      householdId: entry.householdId,
      snapshot: revision(entry.card.cart),
      key,
      until: Date.now() + 120_000,
    });
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
    prune(tickets);
    const ticket = tickets.get(req.body.ticket);
    if (!ticket) return void res.status(410).send("Link expired. Open Review with Instamart again.");
    tickets.delete(req.body.ticket);
    currentCart(ticket);
    prune(sessions);
    const session: Session = {
      ...ticket,
      until: Date.now() + 15 * 60_000,
      verifier: random(),
      state: random(),
      csrf: random(),
    };
    const prior = sessionOf(req);
    if (prior?.client && prior.householdId === ticket.householdId) {
      session.client = prior.client;
      session.until = Math.min(session.until, prior.until);
      if (prior.cartId === ticket.cartId) {
        session.address = prior.address;
        session.reviewNotes = prior.reviewNotes;
      }
    }
    const sealed = store.linkedInstamart(provider + "/" + ticket.householdId);
    if (!session.client && sealed) {
      let credential = unseal(ticket.key, sealed);
      if (credential.expiresAt <= Date.now() + 60_000 && credential.refresh_token) {
        const renewed = await exchange({ grant_type: "refresh_token", refresh_token: credential.refresh_token });
        if (renewed) {
          credential = renewed;
          store.saveInstamartLink(provider + "/" + ticket.householdId, seal(ticket.key, credential));
        }
      }
      if (credential.expiresAt > Date.now() + 60_000) {
        try {
          session.client = await connectInstamart(credential.access_token, network, config.staging);
          session.until = Math.min(session.until, credential.expiresAt);
        } catch (error) {
          if (!(error instanceof Error && "status" in error && error.status === 401)) throw error;
        }
      }
    }
    const key = random();
    sessions.set(key, session);
    res.cookie("instamart_session", key, {
      httpOnly: true,
      sameSite: "lax",
      secure: host.protocol === "https:",
      path: "/instamart",
      maxAge: 15 * 60_000,
    });
    if (session.client)
      return void res.redirect(303, store.instamartClaimed(session.cartId) ? "/instamart/prepared" : "/instamart/addresses");
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
  const currentCart = (s: Ticket): Cart => {
    const e = store.action(s.cartId);
    if (!e || e.done || e.householdId !== s.householdId || e.card.type !== "cart")
      fail(409, "This cart changed. Reopen it from the app.");
    if (revision(e.card.cart) !== s.snapshot) fail(409, "This cart changed. Reopen it from the app.");
    return e.card.cart;
  };
  const revision = (cart: Cart) => createHash("sha256").update(JSON.stringify(cart)).digest("hex");
  const samePreparedCart = (s: Session) => {
    if (store.instamartClaimed(s.cartId) !== revision(currentCart(s)))
      fail(
        409,
        "The household list changed after these packs were sent. Review the updated list in the app and adjust the existing Instamart cart.",
      );
  };
  const formSession = (req: Request) => {
    const s = sessionOf(req);
    if (!s || !s.client || s.csrf !== req.body?.csrf) fail(403, "Review session expired. Reopen the cart from the app.");
    return s;
  };
  router.get(CALLBACK, async (req, res) => {
    const s = sessionOf(req);
    if (!s || !s.state || req.query.state !== s.state || typeof req.query.code !== "string") return void res.sendStatus(403);
    currentCart(s);
    s.state = "";
    const credential = await exchange({
      grant_type: "authorization_code",
      code: req.query.code,
      code_verifier: s.verifier,
      redirect_uri: origin + CALLBACK,
    });
    s.verifier = "";
    if (!credential) fail(401, "Swiggy login expired. Open Review with Instamart again.");
    s.until = Math.min(s.until, credential.expiresAt);
    s.client = await connectInstamart(credential.access_token, network, config.staging);
    store.saveInstamartLink(provider + "/" + s.householdId, seal(s.key, credential));
    res.redirect(303, store.instamartClaimed(s.cartId) ? "/instamart/prepared" : "/instamart/addresses");
  });
  router.get("/instamart/prepared", async (req, res) => {
    const s = sessionOf(req);
    if (!s?.client || !store.instamartClaimed(s.cartId)) return void res.sendStatus(403);
    const latest = await s.client.cart();
    samePreparedCart(s);
    s.address ??= latest.selectedAddressDetails?.id;
    s.reviewNotes ??= ["Check the current Instamart cart. Requests to add these packs are sent only once."];
    invoice(s, latest, res);
  });
  router.get("/instamart/addresses", async (req, res) => {
    const s = sessionOf(req);
    if (!s?.client) return void res.sendStatus(403);
    const pageNumber = Number(req.query.page ?? 1);
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) return void res.sendStatus(400);
    const data = await s.client.addresses(pageNumber);
    s.addresses = new Map(data.addresses.map((a) => [a.id, a.addressLine]));
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
    const s = formSession(req);
    if (s.busy || s.bill || store.instamartClaimed(s.cartId))
      fail(409, "This cart was already prepared. Review it in Swiggy.");
    const address = req.body.address;
    if (!s.addresses?.has(address)) fail(400, "Choose a listed address.");
    const cart = currentCart(s);
    const options: PickedPack[][] = [];
    for (const line of cart.lines) {
      const query = [line.brand, line.item].filter(Boolean).join(" ").replaceAll("-", " ");
      const found = await s.client!.search(address, query);
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
    const s = formSession(req);
    if (!s.options || !s.address || s.busy || s.bill || revision(currentCart(s)) !== s.local)
      fail(409, "Cart changed. Review from the app again.");
    const picked: PickedPack[] = [];
    const notes: string[] = [];
    for (const [i, options] of s.options.entries()) {
      const sku = req.body["line" + i];
      if (sku === "") {
        notes.push(currentCart(s).lines[i]!.item + " omitted");
        continue;
      }
      const p = options.find((p) => p.variant.skuId === sku);
      if (!p) fail(400, "Select a listed pack or leave the item out.");
      picked.push(p);
      if (p.variant.sla)
        notes.push(p.variant.displayName + " delivery estimate: " + p.variant.sla.value + " " + p.variant.sla.unit);
    }
    if (!picked.length) fail(400, "Choose at least one pack.");
    if (updating.has(s.householdId)) fail(409, "Another household cart update is in progress. Retry after it finishes.");
    updating.add(s.householdId);
    s.busy = true;
    try {
      const before = await s.client!.cart();
      if (!Array.isArray(before.items) || (before.items.length && before.selectedAddressDetails?.id !== s.address)) {
        fail(409, "Check the existing cart and selected address in Swiggy first.");
      }
      let items;
      try {
        items = additions(before.items, s.options, picked);
      } catch (error) {
        fail(409, error instanceof Error ? error.message : "Review pack sizes.");
      }
      if (revision(currentCart(s)) !== s.local || !store.claimInstamart(s.cartId, s.local))
        fail(409, "This cart changed or is already being prepared. Check Swiggy.");
      const cart = await s.client!.update(s.address, items);
      s.reviewNotes = [
        ...notes,
        ...(cart.removedOutOfStockItems ?? []).map((i) => i.itemName + " was removed"),
        ...(cart.reducedQuantityItems ?? []).map((i) => i.itemName + " reduced to " + i.cappedQuantity),
      ];
      invoice(s, cart, res);
    } finally {
      s.busy = false;
      updating.delete(s.householdId);
    }
  });
  router.post("/instamart/continue", async (req, res) => {
    const s = formSession(req);
    if (!s.bill) fail(409, "Review your cart before continuing.");
    const latest = await s.client!.cart();
    samePreparedCart(s);
    invoice(s, latest, res, true, config.staging);
  });
  return router;
}
