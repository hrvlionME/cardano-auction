/**
 * A read-only HTTP view of the indexer's database.
 *
 * **This API cannot move money, and that is the design, not a limitation.**
 * It holds no keys and signs nothing. Every state change in this system
 * happens as a transaction signed by whoever owns the funds, validated by the
 * script on-chain. What lives here is a *projection* of what already happened.
 *
 * The consequence worth stating in the thesis: this server can lag, crash,
 * serve stale data, or lie outright, and no bidder loses a lovelace. The worst
 * it can do is mislead someone about the state of an auction -- which is a real
 * harm, but a different and much smaller one than being able to take funds. A
 * conventional auction site's backend can do both.
 *
 * Bidding therefore does not go through here. It goes through a wallet, and
 * `deno task bid` is the demonstration of that path.
 *
 * One thing here is *not* chain data: `name` beside a bidder's address. That
 * comes from the accounts table and is decoration -- what this site happens to
 * know about who controls an address. The address stays in every response
 * alongside it, because the address is what the validator paid and what an
 * explorer will confirm. Only a user's chosen display name is ever exposed;
 * nothing else about an account is readable by another user.
 */
import {
  type AuctionRow,
  countEvents,
  type Db,
  getAuction,
  highestBid,
  listAuctions,
  listEvents,
} from "./db.ts";
import { network } from "../config.ts";
import { displayNames } from "../app/db.ts";

/** Where an auction is in its life, derived rather than stored. */
export type Phase = "bidding" | "closed" | "settled";

function phaseOf(a: AuctionRow, now = Date.now()): Phase {
  if (a.status === "settled") return "settled";
  return now > a.endTime ? "closed" : "bidding";
}

async function summarise(db: Db, a: AuctionRow, names: Record<string, string> = {}) {
  const lead = await highestBid(db, a.policyId);
  return {
    policyId: a.policyId,
    tokenName: a.tokenName,
    unit: a.unit,
    address: a.address,
    sellerAddress: a.sellerAddress,
    minBidLovelace: a.minBid,
    endTime: a.endTime,
    endTimeIso: new Date(a.endTime).toISOString(),
    phase: phaseOf(a),
    bidCount: await countEvents(db, a.policyId, "bid"),
    leader: lead
      ? {
        address: lead.bidderAddress,
        name: lead.bidderAddress ? names[lead.bidderAddress] ?? null : null,
        amountLovelace: lead.amount,
        txHash: lead.txHash,
        at: new Date(lead.blockTime * 1000).toISOString(),
      }
      : null,
    /** What the next bid must exceed: the standing bid, or the reserve. */
    nextBidMustExceedLovelace: lead?.amount ?? a.minBid - 1,
    /**
     * The minting policy's parameters, so a client can rebuild that policy and
     * burn the token. All of it is public: the seed UTxO is a spent input
     * anyone can read, and the key hash is the seller address's payment
     * credential. Null when the lot predates this being recorded.
     */
    lot: a.seedTxHash && a.sellerPkh
      ? {
        seed: { txHash: a.seedTxHash, outputIndex: a.seedOutputIndex ?? 0 },
        sellerPkh: a.sellerPkh,
        tokenNameHex: a.unit.slice(a.policyId.length),
      }
      : null,
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // Open CORS: everything served here is public chain data, and a frontend
      // has to be able to read it from another origin.
      "access-control-allow-origin": "*",
    },
  });

/**
 * Route a request. Split out from the server so it can be exercised directly
 * in a test without binding a port.
 */
export async function handle(db: Db, req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);
  const parts = pathname.split("/").filter(Boolean);

  if (req.method !== "GET") {
    return json({ error: "This API is read-only. State changes are signed transactions." }, 405);
  }

  // GET /health
  if (parts.length === 0 || parts[0] === "health") {
    const auctions = await listAuctions(db);
    return json({
      ok: true,
      network,
      auctions: auctions.length,
      readOnly: true,
      note: "A projection of on-chain state. Holds no keys; cannot move funds.",
      endpoints: [
        "GET /auctions",
        "GET /auctions/:policyId",
        "GET /auctions/:policyId/events",
      ],
    });
  }

  if (parts[0] !== "auctions") return json({ error: `No such path: ${pathname}` }, 404);

  // GET /auctions
  if (parts.length === 1) {
    const rows = await listAuctions(db);
    const leaders = await Promise.all(rows.map((a) => highestBid(db, a.policyId)));
    const names = await displayNames(
      db,
      leaders.map((l) => l?.bidderAddress).filter((x): x is string => Boolean(x)),
    );
    // Sequential rather than Promise.all: each summary runs two more queries,
    // and the pool holds four connections. Fanning out here would let one
    // request starve the sync loop of a connection for no useful speed-up on a
    // handful of auctions.
    const auctions = [];
    for (const a of rows) auctions.push(await summarise(db, a, names));
    return json({ network, auctions });
  }

  const policyId = parts[1]!;
  const auction = await getAuction(db, policyId);
  if (!auction) return json({ error: `No auction with policy id ${policyId}` }, 404);

  const events = async () => {
    const rows = await listEvents(db, policyId);
    const names = await displayNames(
      db,
      rows.map((e) => e.bidderAddress).filter((x): x is string => Boolean(x)),
    );
    return rows.map((e) => ({
      kind: e.kind,
      txHash: e.txHash,
      outputIndex: e.outputIndex,
      blockHeight: e.blockHeight,
      at: new Date(e.blockTime * 1000).toISOString(),
      bidderAddress: e.bidderAddress,
      bidderName: e.bidderAddress ? names[e.bidderAddress] ?? null : null,
      amountLovelace: e.amount,
      datum: e.datum,
    }));
  };

  // GET /auctions/:policyId
  if (parts.length === 2) {
    const lead = await highestBid(db, policyId);
    const names = await displayNames(db, lead?.bidderAddress ? [lead.bidderAddress] : []);
    return json({ ...(await summarise(db, auction, names)), events: await events() });
  }

  // GET /auctions/:policyId/events
  if (parts.length === 3 && parts[2] === "events") {
    return json({ policyId, events: await events() });
  }

  return json({ error: `No such path: ${pathname}` }, 404);
}
