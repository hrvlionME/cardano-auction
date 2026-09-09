/**
 * Replay each known auction's history from the chain into the database.
 *
 * The awkward part of indexing this contract is not the syncing -- it is
 * knowing what to sync. Because `AuctionParams` are compile-time parameters,
 * every auction compiles to a different script with a different hash and
 * therefore lives at a *different address*. There is no "the auction contract"
 * to watch. The indexer holds a list of addresses and can only ever learn
 * about auctions somebody told it about.
 *
 * Here that registry comes from `state/auction-*.json`, written by
 * `open-auction`. In a deployed system it would be a table the API writes when
 * it creates an auction. Either way the property is the same and it is a real
 * limitation: an auction opened by a stranger, against the same validator
 * source but with different parameters, is invisible to this indexer forever.
 *
 * That is the cost of compile-time parameters, and it is the concrete argument
 * for the alternative design -- parameters in the datum, one shared script, one
 * address to watch -- which trades this away for having to validate parameters
 * the chain did not derive.
 */
import { Data } from "@lucid-evolution/lucid";
import { blockfrostProjectId, blockfrostUrl, network } from "../config.ts";
import { AuctionDatum, fromPlutusAddress } from "../types.ts";
import { type AuctionState, deserialiseParams, type LotState } from "../state.ts";
import { auctionAddress } from "../blueprint.ts";
import {
  type AuctionRow,
  type Db,
  getCursor,
  insertEvent,
  setCursor,
  setStatus,
  upsertAuction,
} from "./db.ts";

interface AddressTx {
  tx_hash: string;
  block_height: number;
  block_time: number;
}

interface TxIo {
  inputs: { address: string }[];
  outputs: {
    address: string;
    output_index: number;
    inline_datum: string | null;
    amount: { unit: string; quantity: string }[];
  }[];
}

async function blockfrost<T>(path: string): Promise<T> {
  const res = await fetch(`${blockfrostUrl()}${path}`, {
    headers: { project_id: blockfrostProjectId() },
  });
  if (res.status === 404) return [] as unknown as T;
  if (!res.ok) throw new Error(`Blockfrost ${path} returned ${res.status} ${res.statusText}`);
  return await res.json() as T;
}

/**
 * Load every auction the CLI has opened into the database.
 *
 * The address is re-derived from the saved parameters rather than trusted, for
 * the same reason every transaction re-derives it: if the Haskell has moved,
 * the saved address belongs to a script this code can no longer produce, and
 * indexing it would quietly populate a database with the wrong auction.
 */
export async function registerKnownAuctions(db: Db): Promise<AuctionRow[]> {
  const registered: AuctionRow[] = [];
  let entries: Deno.DirEntry[] = [];
  try {
    entries = [...Deno.readDirSync("state")];
  } catch {
    return registered;
  }

  for (const e of entries) {
    if (!e.isFile || !e.name.startsWith("auction-") || !e.name.endsWith(".json")) continue;
    const saved = JSON.parse(await Deno.readTextFile(`state/${e.name}`)) as AuctionState;

    let params, address: string;
    try {
      params = deserialiseParams(saved.params);
      address = await auctionAddress(params);
    } catch {
      // An auction recorded under an older datum format. History, not an error.
      console.log(`  skip  ${saved.tokenName}: parameters predate the current types`);
      continue;
    }
    if (address !== saved.address) {
      console.log(`  skip  ${saved.tokenName}: scripts changed since it was opened`);
      continue;
    }

    // The minting policy's parameters live in the lot file, not the auction
    // file. They are needed to rebuild that policy and burn the token, so a
    // client can offer to claim without reading this machine's disk. Absent is
    // fine: only the burn needs them.
    let lot: LotState | undefined;
    try {
      lot = JSON.parse(
        await Deno.readTextFile(`state/lot-${saved.policyId}.json`),
      ) as LotState;
    } catch {
      lot = undefined;
    }

    const row: AuctionRow = {
      policyId: saved.policyId,
      tokenName: saved.tokenName,
      unit: saved.unit,
      address,
      sellerAddress: fromPlutusAddress(params.apSeller),
      minBid: Number(params.apMinBid),
      endTime: Number(params.apEndTime),
      status: "open",
      network,
      seedTxHash: lot?.seed.txHash ?? null,
      seedOutputIndex: lot?.seed.outputIndex ?? null,
      sellerPkh: lot?.sellerPkh ?? null,
    };
    await upsertAuction(db, row);
    registered.push(row);
  }
  return registered;
}

/**
 * Bring one auction up to date.
 *
 * Every transaction that touched the auction's address is classified by shape,
 * which is enough to reconstruct the whole history without interpreting
 * redeemers:
 *
 *   output at the address, no input from it   -> open
 *   input from the address, output back to it -> bid
 *   input from the address, no output back    -> settle
 *
 * The datum on the continuing output says who leads and by how much, so a bid
 * needs no other source. Note this reads *outputs*, not redeemers: the chain
 * records what happened, and what happened is where the value went.
 */
export async function syncAuction(db: Db, a: AuctionRow): Promise<number> {
  const from = await getCursor(db, a.policyId);
  const query = from > 0 ? `?order=asc&from=${from}` : `?order=asc`;
  const txs = await blockfrost<AddressTx[]>(`/addresses/${a.address}/transactions${query}`);

  let added = 0;
  let highestBlock = from;

  for (const tx of txs) {
    const io = await blockfrost<TxIo>(`/txs/${tx.tx_hash}/utxos`);
    const spentFromAuction = io.inputs.some((i) => i.address === a.address);
    const continuing = io.outputs.find(
      (o) => o.address === a.address && o.amount.some((x) => x.unit === a.unit),
    );

    let kind: "open" | "bid" | "settle";
    if (continuing && !spentFromAuction) kind = "open";
    else if (continuing) kind = "bid";
    else if (spentFromAuction) kind = "settle";
    else continue; // touched the address but moved no lot; not part of the story

    let bidderAddress: string | null = null;
    let amount: number | null = null;
    const datum = continuing?.inline_datum ?? null;

    if (continuing) {
      amount = Number(continuing.amount.find((x) => x.unit === "lovelace")?.quantity ?? "0");
      if (datum) {
        const bid = Data.from(datum, AuctionDatum);
        if (bid) bidderAddress = fromPlutusAddress(bid.bAddress);
      }
    }

    if (await insertEvent(db, {
      policyId: a.policyId,
      kind,
      txHash: tx.tx_hash,
      outputIndex: continuing?.output_index ?? null,
      blockHeight: tx.block_height,
      blockTime: tx.block_time,
      bidderAddress,
      amount,
      datum,
    })) added++;

    if (kind === "settle") await setStatus(db, a.policyId, "settled");
    highestBlock = Math.max(highestBlock, tx.block_height);
  }

  // Rewind one block before storing the cursor. Blockfrost's `from` filter is
  // inclusive of the block, and a block can hold more than one transaction for
  // an address; starting again one block back costs a redundant fetch and the
  // UNIQUE constraint discards the duplicates, whereas starting one block too
  // far ahead would silently lose an event.
  if (highestBlock > 0) await setCursor(db, a.policyId, Math.max(0, highestBlock - 1));
  return added;
}

export async function syncAll(db: Db): Promise<{ auctions: number; events: number }> {
  const auctions = await registerKnownAuctions(db);
  let events = 0;
  for (const a of auctions) {
    const n = await syncAuction(db, a);
    events += n;
    console.log(`  ${a.tokenName.padEnd(10)} ${n} new event(s)`);
  }
  return { auctions: auctions.length, events };
}
