/**
 * A pass-through to Blockfrost for the browser.
 *
 * The web app has to read the chain (to find the live auction UTxO) and has to
 * evaluate and submit transactions. All three go through Blockfrost, which
 * needs a project id -- and a project id shipped to a browser is a project id
 * published. Anyone reading the page source gets it.
 *
 * So the browser talks to this instead, and the key stays on the server.
 *
 * **This does not weaken the claim that the server cannot move money.** A
 * Blockfrost project id is a read-and-relay credential for a public node: it
 * can query the chain and hand a *already-signed* transaction to the network.
 * It cannot sign anything, because signing needs a private key and there is no
 * private key here. Everything that crosses this proxy on its way to the chain
 * was signed in the user's wallet, by the user, moments earlier. The proxy is a
 * postbox, not an authority -- it can refuse to post a letter, or lose one, but
 * it cannot write one.
 *
 * What it *can* do is burn the operator's Blockfrost rate limit, since it
 * relays for anyone who can reach it. On localhost that is nobody. Exposing
 * this to the internet would want an allowlist of paths and a rate limit of its
 * own; that is noted here rather than implemented because this server is a
 * demonstration and says so.
 */
import { blockfrostProjectId, blockfrostUrl } from "../config.ts";

export const CHAIN_PREFIX = "/chain/";

/** Headers every proxied answer carries, so a page on another origin can read it. */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * Forward `/chain/<path>` to `<blockfrost>/<path>`.
 *
 * Method and body pass through unchanged: Lucid's provider needs GET for
 * queries, POST for `/utils/txs/evaluate`, and POST with a CBOR body for
 * `/tx/submit`. Only the `project_id` header is added, and it is added here so
 * that it is never anywhere the browser can see.
 */
export async function proxyChain(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const path = url.pathname.slice(CHAIN_PREFIX.length);
  if (!path) {
    return new Response(JSON.stringify({ error: "No Blockfrost path given." }), {
      status: 400,
      headers: { "content-type": "application/json", ...CORS },
    });
  }

  const target = `${blockfrostUrl()}/${path}${url.search}`;
  const headers = new Headers({ project_id: blockfrostProjectId() });
  // Submission sends CBOR; evaluation sends JSON. Preserve whichever it is.
  const contentType = req.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer(),
    });
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Could not reach Blockfrost: ${e instanceof Error ? e.message : e}` }),
      { status: 502, headers: { "content-type": "application/json", ...CORS } },
    );
  }

  // Blockfrost's own status and body go straight back. Lucid reads the error
  // text on a rejected submission, and rewriting it here would replace a
  // precise ledger complaint with a vague one.
  const body = await upstream.arrayBuffer();
  const out = new Headers(CORS);
  const upstreamType = upstream.headers.get("content-type");
  if (upstreamType) out.set("content-type", upstreamType);
  return new Response(body, { status: upstream.status, headers: out });
}
