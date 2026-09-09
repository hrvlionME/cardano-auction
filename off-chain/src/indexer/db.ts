/**
 * The indexer's database: MariaDB, via the `mysql2` driver.
 *
 * Everything here is *derived* data. The chain is the source of truth; this is
 * a cache that exists so a UI can ask "what is the bid history" without
 * replaying transactions itself.
 *
 * That framing matters for the thesis: nothing in the database is authoritative
 * and nothing is trusted. If it disagrees with the chain, the chain wins and
 * the fix is `deno task db:reset`, which drops every table and rebuilds it from
 * the chain. A read model is allowed to be wrong; it is not allowed to be
 * believed over the ledger.
 *
 * Why a client/server database rather than an embedded one: an embedded store
 * is a file owned by one process, which is the right shape for a single CLI
 * indexer and the wrong shape for what comes next -- an indexer writing while
 * an API server and a browser frontend read, potentially on different hosts.
 * MariaDB gives those readers a connection instead of requiring them to share a
 * filesystem. The cost is a daemon that has to be running, which is why
 * `openDb` fails with setup instructions rather than a driver stack trace.
 */
import mysql from "mysql2/promise";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { dbConfig } from "../config.ts";

/** The handle every function here takes. A pool, not a connection: the sync
 * loop and the HTTP server run concurrently and must not share one socket. */
export type Db = Pool;

/**
 * An auction the indexer knows about.
 *
 * Note `address` is unique per auction, not per contract. Because the
 * validator takes its parameters at compile time, every auction is a different
 * script with a different hash and therefore a different address -- so the
 * indexer cannot watch "the auction contract". It watches a list of addresses,
 * and it can only ever know about auctions it has been told about. See
 * `registerKnownAuctions` in sync.ts.
 */
export interface AuctionRow {
  policyId: string;
  tokenName: string;
  unit: string;
  address: string;
  sellerAddress: string;
  minBid: number;
  endTime: number;
  status: "open" | "settled";
  network: string;
  /**
   * The UTxO whose consumption made the mint unrepeatable, and the seller's
   * payment key hash. Both are parameters of the minting policy, so a client
   * needs them to rebuild that policy and burn the token. Null for auctions
   * registered before this was recorded, or whose lot file is missing.
   */
  seedTxHash: string | null;
  seedOutputIndex: number | null;
  sellerPkh: string | null;
}

/** One thing that happened to an auction, in chain order. */
export interface EventRow {
  id: number;
  policyId: string;
  kind: "open" | "bid" | "settle";
  txHash: string;
  outputIndex: number | null;
  blockHeight: number;
  blockTime: number;
  /** Who leads after this event, as they named themselves. null for open/settle. */
  bidderAddress: string | null;
  /** Lovelace held by the auction UTxO after this event. null once settled. */
  amount: number | null;
  datum: string | null;
}

/**
 * Column widths are deliberate rather than generous defaults.
 *
 * A Cardano policy id is a 28-byte hash, so 56 hex characters exactly. A
 * transaction hash is 32 bytes, so 64. A bech32 base address on this network
 * runs to about 110 characters; 160 leaves room without pushing the UNIQUE
 * index near InnoDB's key-length limit. Sizing these honestly is the small tax
 * a client/server database charges that an embedded one does not: SQLite would
 * have taken `TEXT` for all of them and stored exactly what it was given.
 *
 * `status` and `kind` are ENUMs. SQLite expressed the same constraint as a
 * CHECK; MariaDB has a native type for "one of these strings", so use it.
 */
const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS auctions (
     policy_id       VARCHAR(56)  NOT NULL,
     token_name      VARCHAR(64)  NOT NULL,
     unit            VARCHAR(128) NOT NULL,
     address         VARCHAR(160) NOT NULL,
     seller_address  VARCHAR(160) NOT NULL,
     min_bid         BIGINT       NOT NULL,
     end_time        BIGINT       NOT NULL,
     status          ENUM('open','settled') NOT NULL DEFAULT 'open',
     network         VARCHAR(16)  NOT NULL,
     seed_tx_hash      VARCHAR(64) NULL,
     seed_output_index INT         NULL,
     seller_pkh        VARCHAR(56) NULL,
     PRIMARY KEY (policy_id),
     UNIQUE KEY uniq_auction_address (address)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // One row per transaction that touched an auction's address.
  // The UNIQUE key is what makes syncing idempotent: re-running the indexer
  // over transactions it has already seen inserts nothing, so a sync can be
  // interrupted at any point and simply run again.
  `CREATE TABLE IF NOT EXISTS events (
     id             BIGINT       NOT NULL AUTO_INCREMENT,
     policy_id      VARCHAR(56)  NOT NULL,
     kind           ENUM('open','bid','settle') NOT NULL,
     tx_hash        VARCHAR(64)  NOT NULL,
     output_index   INT          NULL,
     block_height   BIGINT       NOT NULL,
     block_time     BIGINT       NOT NULL,
     bidder_address VARCHAR(160) NULL,
     amount         BIGINT       NULL,
     datum          TEXT         NULL,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_auction_tx (policy_id, tx_hash),
     KEY events_by_auction (policy_id, block_height, id),
     CONSTRAINT fk_events_auction FOREIGN KEY (policy_id)
       REFERENCES auctions (policy_id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // How far each auction has been synced, so a re-run asks Blockfrost only for
  // blocks it has not seen. Without this the indexer refetches an auction's
  // whole history every time -- correct, but wasteful and rate-limited.
  `CREATE TABLE IF NOT EXISTS sync_state (
     policy_id    VARCHAR(56) NOT NULL,
     last_block   BIGINT      NOT NULL,
     last_synced  BIGINT      NOT NULL,
     PRIMARY KEY (policy_id),
     CONSTRAINT fk_sync_auction FOREIGN KEY (policy_id)
       REFERENCES auctions (policy_id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // For databases created before the minting-policy parameters were recorded.
  // MariaDB supports IF NOT EXISTS here, so this is a no-op on a fresh schema
  // and the only migration step this project needs.
  `ALTER TABLE auctions
     ADD COLUMN IF NOT EXISTS seed_tx_hash      VARCHAR(64) NULL,
     ADD COLUMN IF NOT EXISTS seed_output_index INT         NULL,
     ADD COLUMN IF NOT EXISTS seller_pkh        VARCHAR(56) NULL`,
];

/** Tables in dependency order, so dropping them in reverse satisfies the keys. */
export const TABLES = ["auctions", "events", "sync_state"] as const;

function setupHelp(cfg: ReturnType<typeof dbConfig>, cause: string): Error {
  return new Error(
    `Cannot reach MariaDB at ${cfg.host}:${cfg.port} as '${cfg.user}' (${cause}).\n\n` +
      `  Is the server running?    sudo systemctl start mariadb\n` +
      `  Is the database created?  sudo mariadb < sql/setup.sql\n` +
      `  Do the credentials match? DB_* entries in off-chain/.env\n`,
  );
}

/**
 * Connect, and make sure the schema exists.
 *
 * Creating the schema on every start is intentional: the tables are derived, so
 * there is nothing to migrate and no state worth protecting. `IF NOT EXISTS`
 * makes it a no-op after the first run.
 */
export async function openDb(): Promise<Db> {
  const cfg = dbConfig();
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: 4,
    // Timestamps and lovelace amounts are well inside 2^53, so the driver's
    // default number conversion is safe here and keeps the row types plain.
    supportBigNumbers: true,
    bigNumberStrings: false,
  });

  try {
    const conn = await pool.getConnection();
    conn.release();
  } catch (e) {
    await pool.end().catch(() => {});
    throw setupHelp(cfg, e instanceof Error ? e.message : String(e));
  }

  for (const stmt of SCHEMA) await pool.query(stmt);
  return pool;
}

export async function closeDb(db: Db): Promise<void> {
  await db.end();
}

/**
 * Drop every table. The point of the command that calls this: the database can
 * be destroyed completely and rebuilt from the chain, which is the practical
 * proof that it holds nothing authoritative.
 */
export async function dropAll(db: Db): Promise<void> {
  await db.query("SET FOREIGN_KEY_CHECKS = 0");
  for (const t of [...TABLES].reverse()) await db.query(`DROP TABLE IF EXISTS \`${t}\``);
  await db.query("SET FOREIGN_KEY_CHECKS = 1");
}

export async function upsertAuction(db: Db, a: AuctionRow): Promise<void> {
  await db.query(
    `INSERT INTO auctions
       (policy_id, token_name, unit, address, seller_address, min_bid, end_time, status,
        network, seed_tx_hash, seed_output_index, seller_pkh)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       token_name        = VALUES(token_name),
       unit              = VALUES(unit),
       address           = VALUES(address),
       seller_address    = VALUES(seller_address),
       min_bid           = VALUES(min_bid),
       end_time          = VALUES(end_time),
       network           = VALUES(network),
       seed_tx_hash      = COALESCE(VALUES(seed_tx_hash), seed_tx_hash),
       seed_output_index = COALESCE(VALUES(seed_output_index), seed_output_index),
       seller_pkh        = COALESCE(VALUES(seller_pkh), seller_pkh)`,
    [
      a.policyId,
      a.tokenName,
      a.unit,
      a.address,
      a.sellerAddress,
      a.minBid,
      a.endTime,
      a.status,
      a.network,
      a.seedTxHash,
      a.seedOutputIndex,
      a.sellerPkh,
    ],
  );
}

/** Returns true if the event was new. Duplicates are ignored, not errors. */
export async function insertEvent(db: Db, e: Omit<EventRow, "id">): Promise<boolean> {
  const [res] = await db.query<ResultSetHeader>(
    `INSERT IGNORE INTO events
       (policy_id, kind, tx_hash, output_index, block_height, block_time,
        bidder_address, amount, datum)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.policyId,
      e.kind,
      e.txHash,
      e.outputIndex,
      e.blockHeight,
      e.blockTime,
      e.bidderAddress,
      e.amount,
      e.datum,
    ],
  );
  return res.affectedRows > 0;
}

export async function setStatus(db: Db, policyId: string, status: AuctionRow["status"]) {
  await db.query(`UPDATE auctions SET status = ? WHERE policy_id = ?`, [status, policyId]);
}

export async function getCursor(db: Db, policyId: string): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT last_block FROM sync_state WHERE policy_id = ?`,
    [policyId],
  );
  return Number(rows[0]?.last_block ?? 0);
}

export async function setCursor(db: Db, policyId: string, lastBlock: number): Promise<void> {
  await db.query(
    `INSERT INTO sync_state (policy_id, last_block, last_synced) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE last_block  = VALUES(last_block),
                             last_synced = VALUES(last_synced)`,
    [policyId, lastBlock, Math.floor(Date.now() / 1000)],
  );
}

// ------------------------------------------------------------------ queries

const AUCTION_COLUMNS = `policy_id      AS policyId,
                         token_name     AS tokenName,
                         unit           AS unit,
                         address        AS address,
                         seller_address AS sellerAddress,
                         min_bid        AS minBid,
                         end_time       AS endTime,
                         status         AS status,
                         network        AS network,
                         seed_tx_hash      AS seedTxHash,
                         seed_output_index AS seedOutputIndex,
                         seller_pkh        AS sellerPkh`;

export async function listAuctions(db: Db): Promise<AuctionRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${AUCTION_COLUMNS} FROM auctions ORDER BY end_time DESC`,
  );
  return rows as unknown as AuctionRow[];
}

export async function getAuction(db: Db, policyId: string): Promise<AuctionRow | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${AUCTION_COLUMNS} FROM auctions WHERE policy_id = ?`,
    [policyId],
  );
  return rows[0] as unknown as AuctionRow | undefined;
}

const EVENT_COLUMNS = `id, policy_id AS policyId, kind, tx_hash AS txHash,
                       output_index AS outputIndex, block_height AS blockHeight,
                       block_time AS blockTime, bidder_address AS bidderAddress,
                       amount, datum`;

/** An auction's history, oldest first. */
export async function listEvents(db: Db, policyId: string): Promise<EventRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${EVENT_COLUMNS} FROM events WHERE policy_id = ? ORDER BY block_height, id`,
    [policyId],
  );
  return rows as unknown as EventRow[];
}

/** How many events of a kind an auction has. */
export async function countEvents(
  db: Db,
  policyId: string,
  kind: EventRow["kind"],
): Promise<number> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS n FROM events WHERE policy_id = ? AND kind = ?`,
    [policyId, kind],
  );
  return Number(rows[0]?.n ?? 0);
}

/** The standing bid: the most recent 'bid' event, if the auction had any. */
export async function highestBid(db: Db, policyId: string): Promise<EventRow | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${EVENT_COLUMNS} FROM events
      WHERE policy_id = ? AND kind = 'bid'
      ORDER BY block_height DESC, id DESC LIMIT 1`,
    [policyId],
  );
  return rows[0] as unknown as EventRow | undefined;
}
