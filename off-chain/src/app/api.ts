/**
 * Accounts: sign-in by wallet signature, profile, and verifiable history.
 *
 * **These endpoints write, and the read model's do not.** That distinction is
 * worth stating precisely rather than quietly relaxing the earlier claim: what
 * is written here is *application* state -- who someone is, where to send a
 * parcel -- and none of it can move a lovelace. The chain-facing API remains
 * read-only, and bidding still happens only through a wallet. The server has
 * gained the ability to remember you; it has not gained the ability to spend
 * for you.
 *
 * Authentication is CIP-30 `signData` against a server-issued nonce:
 *
 *   1. browser asks for a nonce for an address
 *   2. wallet signs a message containing it, and shows the user what it signs
 *   3. server rebuilds that exact message and verifies the signature
 *
 * The message is reconstructed here rather than accepted from the client. A
 * server that verifies a *client-supplied* payload proves only that the client
 * signed something -- it must be our nonce, for that address, or the check is
 * theatre. The nonce is single-use and expires, because one that can be
 * replayed is a password and one that never expires is a password that never
 * rotates.
 *
 * What is deliberately absent: passwords. There is nothing to store, nothing
 * to reset, and nothing to leak. The address that authenticates is the address
 * that bids, so an account and its bidder cannot drift apart.
 */
import { getAddressDetails, verifyData } from "@lucid-evolution/lucid";
import type { Db } from "../indexer/db.ts";
import {
  addressesOf,
  consumeNonce,
  createSession,
  createUser,
  endSession,
  historyFor,
  issueNonce,
  linkAddress,
  type ProfilePatch,
  purgeNonces,
  SESSION_TTL_MS,
  sessionUser,
  updateProfile,
  userByAddress,
} from "./db.ts";

export const APP_PATHS = ["/auth", "/me"];

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });

const hex = (s: string) =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The message the wallet displays and signs.
 *
 * Readable on purpose: the user sees this in Eternl before approving, and a
 * prompt showing opaque hex teaches people to approve things they have not
 * read. It names the site so a signature collected here cannot be presented
 * elsewhere as a login to something else.
 */
export function signInMessage(address: string, nonce: string): string {
  return [
    "Cardano Auction - sign in",
    "",
    "Signing this proves you control this address.",
    "It authorises no payment and moves no funds.",
    "",
    `address: ${address}`,
    `nonce:   ${nonce}`,
  ].join("\n");
}

function cookie(name: string, value: string, maxAgeSec: number): string {
  // No `Secure`: the demo is served over http on localhost, where that flag
  // would stop the cookie being stored at all. Anything deployed publicly must
  // add it, and must be behind TLS.
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function readCookie(req: Request, name: string): string | undefined {
  const raw = req.headers.get("cookie");
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

async function body<T>(req: Request): Promise<T | undefined> {
  try {
    return await req.json() as T;
  } catch {
    return undefined;
  }
}

/** The signed-in user, or undefined. */
async function current(db: Db, req: Request) {
  const token = readCookie(req, "session");
  return token ? await sessionUser(db, token) : undefined;
}

async function meResponse(db: Db, userId: number, address: string) {
  const [addresses, user] = await Promise.all([
    addressesOf(db, userId),
    userByAddress(db, address),
  ]);
  return { user, address, addresses };
}

export async function handleApp(db: Db, req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // ---------------------------------------------------------------- nonce
  if (pathname === "/auth/nonce" && req.method === "POST") {
    const b = await body<{ address?: string }>(req);
    if (!b?.address) return json({ error: "address is required" }, 400);
    try {
      getAddressDetails(b.address);
    } catch {
      return json({ error: "That is not a valid Cardano address." }, 400);
    }
    await purgeNonces(db);
    const nonce = await issueNonce(db, b.address);
    const message = signInMessage(b.address, nonce);
    return json({ nonce, message, payloadHex: hex(message) });
  }

  // ---------------------------------------------------------------- login
  if (pathname === "/auth/login" && req.method === "POST") {
    const b = await body<
      { address?: string; nonce?: string; signature?: string; key?: string }
    >(req);
    if (!b?.address || !b.nonce || !b.signature || !b.key) {
      return json({ error: "address, nonce, signature and key are required" }, 400);
    }

    // Spend the nonce first. If it is not ours, not for this address, already
    // used, or expired, nothing below is worth doing.
    if (!await consumeNonce(db, b.nonce, b.address)) {
      return json({ error: "That sign-in request has expired. Try again." }, 401);
    }

    let details;
    try {
      details = getAddressDetails(b.address);
    } catch {
      return json({ error: "That is not a valid Cardano address." }, 400);
    }
    const keyHash = details.paymentCredential?.hash;
    if (!keyHash) return json({ error: "Address has no payment credential." }, 400);

    // Rebuilt here, never taken from the request. See the note at the top.
    const payloadHex = hex(signInMessage(b.address, b.nonce));

    let ok = false;
    try {
      ok = verifyData(details.address.hex, keyHash, payloadHex, {
        signature: b.signature,
        key: b.key,
      });
    } catch {
      ok = false;
    }
    if (!ok) return json({ error: "Signature did not verify for that address." }, 401);

    const existing = await userByAddress(db, b.address);
    const user = existing ?? await createUser(db, b.address);
    if (existing) await linkAddress(db, b.address, user.id);

    const token = await createSession(db, user.id, b.address);
    return json(
      { ...await meResponse(db, user.id, b.address), isNew: existing === undefined },
      200,
      { "set-cookie": cookie("session", token, Math.floor(SESSION_TTL_MS / 1000)) },
    );
  }

  // ------------------------------------------------------------------- me
  if (pathname === "/auth/me" && req.method === "GET") {
    const who = await current(db, req);
    if (!who) return json({ user: null }, 200);
    return json(await meResponse(db, who.user.id, who.address));
  }

  // --------------------------------------------------------------- logout
  if (pathname === "/auth/logout" && req.method === "POST") {
    const token = readCookie(req, "session");
    if (token) await endSession(db, token);
    return json({ ok: true }, 200, { "set-cookie": cookie("session", "", 0) });
  }

  // -------------------------------------------------------------- profile
  if (pathname === "/auth/profile" && req.method === "PUT") {
    const who = await current(db, req);
    if (!who) return json({ error: "Not signed in." }, 401);
    const patch = await body<ProfilePatch>(req);
    if (!patch) return json({ error: "Expected a JSON body." }, 400);
    if (patch.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(patch.email)) {
      return json({ error: "That does not look like an email address." }, 400);
    }
    if (patch.country && !/^[A-Za-z]{2}$/.test(patch.country)) {
      return json({ error: "Country must be a two-letter code, e.g. HR." }, 400);
    }
    try {
      await updateProfile(db, who.user.id, {
        ...patch,
        country: patch.country ? patch.country.toUpperCase() : patch.country,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Duplicate")) {
        return json({ error: "That email is already used by another account." }, 409);
      }
      throw e;
    }
    return json(await meResponse(db, who.user.id, who.address));
  }

  // -------------------------------------------------------------- history
  if (pathname === "/me/history" && req.method === "GET") {
    const who = await current(db, req);
    if (!who) return json({ error: "Not signed in." }, 401);
    return json({ history: await historyFor(db, who.user.id) });
  }

  return json({ error: `No such path: ${pathname}` }, 404);
}
