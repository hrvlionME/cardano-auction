/**
 * Signing in with a wallet, from the browser's side.
 *
 * There are no passwords here. The wallet already proves who you are: the
 * server issues a nonce, the wallet signs a message containing it, and the
 * server checks that signature against the address. What the user sees in the
 * wallet is a readable sentence saying the signature authorises no payment --
 * which is true, and worth their being able to read.
 *
 * An account is **optional**. Connecting a wallet is enough to bid, because
 * bidding is a transaction the chain validates and the server is not consulted.
 * Signing in only adds the things a chain deliberately does not know: a name,
 * an email, somewhere to send the item, and a history assembled for you rather
 * than looked up by hand.
 */
import type { HistoryRow, Me, ProfilePatch } from "./types.ts";

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    // The session is an HttpOnly cookie: unreadable from JavaScript, which is
    // the point. It has to be sent explicitly on same-origin fetches.
    credentials: "same-origin",
    headers: { "content-type": "application/json", ...init.headers },
  });
  // Read as text first. A dev server that has not been told to proxy this path
  // answers 200 with index.html, and parsing that as JSON yields null -- which
  // then propagates as a null user and crashes rendering somewhere unrelated.
  // Failing here names the actual problem.
  const raw = await res.text();
  let body: (T & { error?: string }) | null = null;
  try {
    body = JSON.parse(raw) as T & { error?: string };
  } catch {
    if (!res.ok) throw new Error(`Request failed: ${res.status} ${res.statusText}`);
    throw new Error(
      `${path} did not return JSON. If this is the Vite dev server, add the path to ` +
        `the proxy in vite.config.ts.`,
    );
  }
  if (!res.ok) throw new Error(body?.error ?? `Request failed: ${res.status}`);
  if (body === null) throw new Error(`${path} returned an empty body.`);
  return body;
}

/** Whoever the session cookie belongs to, or a null user. */
export const me = () => call<Me>("/auth/me");

/**
 * The full sign-in round trip.
 *
 * `signMessage` is Lucid's wrapper over CIP-30 `signData`; it is the same call
 * the command line makes, so the signature a browser produces and one produced
 * from a seed phrase are indistinguishable to the server.
 */
export async function signIn(
  lucid: { wallet(): { address(): Promise<string>; signMessage(a: string, p: string): Promise<{ signature: string; key: string }> } },
): Promise<Me & { isNew: boolean }> {
  const address = await lucid.wallet().address();
  const { nonce, payloadHex } = await call<{ nonce: string; payloadHex: string }>(
    "/auth/nonce",
    { method: "POST", body: JSON.stringify({ address }) },
  );
  const signed = await lucid.wallet().signMessage(address, payloadHex);
  return await call<Me & { isNew: boolean }>("/auth/login", {
    method: "POST",
    body: JSON.stringify({ address, nonce, signature: signed.signature, key: signed.key }),
  });
}

export const signOut = () => call<{ ok: true }>("/auth/logout", { method: "POST" });

export const saveProfile = (patch: ProfilePatch) =>
  call<Me>("/auth/profile", { method: "PUT", body: JSON.stringify(patch) });

export const history = () =>
  call<{ history: HistoryRow[] }>("/me/history").then((r) => r.history);
