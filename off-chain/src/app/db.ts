/**
 * The application's own tables: accounts, linked wallet addresses, sign-in
 * challenges and sessions.
 *
 * **These are authoritative, not derived.** That is the whole difference
 * between this module and `src/indexer/db.ts`, and it has a practical
 * consequence: `deno task db:reset` drops and rebuilds the indexer's tables
 * from the chain, and it must never touch these, because nothing here can be
 * recovered from a ledger. `dropAll()` in the indexer only drops the three
 * names listed in its own `TABLES`, which is what keeps them safe -- so that
 * list is load-bearing and should stay narrow.
 *
 * What lives here is everything the chain deliberately does not know: who a
 * bidder is, where a parcel should be sent, whether identity has been checked.
 * Keeping it off-chain is not a shortcut. A ledger is permanent, public, and
 * unfixable; personal data has to live somewhere it can be corrected,
 * access-controlled and *erased*, which is what makes a right-to-erasure
 * request answerable at all.
 *
 * Note what is *not* here: no bids, balances, winners or purchase history.
 * All of that is on the chain and already projected into `events`. Storing it
 * again would create two sources for one fact, and the day they disagreed the
 * database would be believed -- exactly the failure this whole design exists
 * to avoid. History is a join, not a table. See `historyFor` below.
 */
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { Db } from "../indexer/db.ts";

export interface User {
  id: number;
  displayName: string | null;
  email: string | null;
  fullName: string | null;
  addressLine: string | null;
  city: string | null;
  postcode: string | null;
  country: string | null;
  kycStatus: "none" | "pending" | "verified" | "rejected";
  createdAt: string;
}

/** How long a sign-in challenge stays valid. Long enough to read the prompt. */
export const NONCE_TTL_MS = 5 * 60_000;
/** How long a session lasts before the user signs again. */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;

const APP_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS users (
     id            BIGINT NOT NULL AUTO_INCREMENT,
     display_name  VARCHAR(80)  NULL,
     email         VARCHAR(255) NULL,
     full_name     VARCHAR(160) NULL,
     address_line  VARCHAR(255) NULL,
     city          VARCHAR(100) NULL,
     postcode      VARCHAR(20)  NULL,
     country       CHAR(2)      NULL,
     kyc_status    ENUM('none','pending','verified','rejected') NOT NULL DEFAULT 'none',
     created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (id),
     UNIQUE KEY uniq_user_email (email)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Many addresses to one user, deliberately. A wallet holds more than one
  // address -- the base/enterprise distinction that caused the PubKeyHash
  // defect -- and the same person may well bid from several. One row per
  // address, each proved by its own signature.
  `CREATE TABLE IF NOT EXISTS wallet_addresses (
     address     VARCHAR(160) NOT NULL,
     user_id     BIGINT       NOT NULL,
     verified_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
     PRIMARY KEY (address),
     KEY wa_by_user (user_id),
     CONSTRAINT fk_wa_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  // Sign-in challenges. Single-use and short-lived: a nonce that can be
  // replayed is a password, and one that never expires is a password that
  // never rotates.
  `CREATE TABLE IF NOT EXISTS auth_nonces (
     nonce      CHAR(64)     NOT NULL,
     address    VARCHAR(160) NOT NULL,
     expires_at BIGINT       NOT NULL,
     used_at    BIGINT       NULL,
     PRIMARY KEY (nonce),
     KEY an_by_address (address)
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

  `CREATE TABLE IF NOT EXISTS sessions (
     token      CHAR(64) NOT NULL,
     user_id    BIGINT   NOT NULL,
     address    VARCHAR(160) NOT NULL,
     expires_at BIGINT   NOT NULL,
     PRIMARY KEY (token),
     KEY s_by_user (user_id),
     CONSTRAINT fk_s_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
   ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];

export async function ensureAppSchema(db: Db): Promise<void> {
  for (const stmt of APP_SCHEMA) await db.query(stmt);
}

/** 32 random bytes as hex. Used for both nonces and session tokens. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ------------------------------------------------------------------- nonces

export async function issueNonce(db: Db, address: string): Promise<string> {
  const nonce = randomToken();
  await db.query(
    `INSERT INTO auth_nonces (nonce, address, expires_at) VALUES (?, ?, ?)`,
    [nonce, address, Date.now() + NONCE_TTL_MS],
  );
  return nonce;
}

/**
 * Spend a nonce, returning true only if it was valid for this address.
 *
 * The UPDATE is the check: marking it used and requiring `used_at IS NULL` in
 * the same statement means two simultaneous attempts cannot both succeed. Doing
 * this as a SELECT followed by an UPDATE would leave exactly that race open.
 */
export async function consumeNonce(db: Db, nonce: string, address: string): Promise<boolean> {
  const [res] = await db.query<ResultSetHeader>(
    `UPDATE auth_nonces SET used_at = ?
      WHERE nonce = ? AND address = ? AND used_at IS NULL AND expires_at > ?`,
    [Date.now(), nonce, address, Date.now()],
  );
  return res.affectedRows === 1;
}

/** Housekeeping: nonces are worthless once expired. */
export async function purgeNonces(db: Db): Promise<void> {
  await db.query(`DELETE FROM auth_nonces WHERE expires_at < ?`, [Date.now() - NONCE_TTL_MS]);
}

// -------------------------------------------------------------------- users

const USER_COLUMNS = `id, display_name AS displayName, email, full_name AS fullName,
                      address_line AS addressLine, city, postcode, country,
                      kyc_status AS kycStatus, created_at AS createdAt`;

export async function userByAddress(db: Db, address: string): Promise<User | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${USER_COLUMNS} FROM users
      WHERE id = (SELECT user_id FROM wallet_addresses WHERE address = ?)`,
    [address],
  );
  return rows[0] as unknown as User | undefined;
}

export async function userById(db: Db, id: number): Promise<User | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT ${USER_COLUMNS} FROM users WHERE id = ?`,
    [id],
  );
  return rows[0] as unknown as User | undefined;
}

/** Create an account for a freshly proved address. */
export async function createUser(db: Db, address: string): Promise<User> {
  const [res] = await db.query<ResultSetHeader>(`INSERT INTO users () VALUES ()`);
  const id = res.insertId;
  await db.query(
    `INSERT INTO wallet_addresses (address, user_id) VALUES (?, ?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
    [address, id],
  );
  return (await userById(db, id))!;
}

/** Attach another proved address to an existing account. */
export async function linkAddress(db: Db, address: string, userId: number): Promise<void> {
  await db.query(
    `INSERT IGNORE INTO wallet_addresses (address, user_id) VALUES (?, ?)`,
    [address, userId],
  );
}

export async function addressesOf(db: Db, userId: number): Promise<string[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT address FROM wallet_addresses WHERE user_id = ? ORDER BY verified_at`,
    [userId],
  );
  return rows.map((r) => r.address as string);
}

/** Fields a user may set about themselves. Everything else is ours. */
export type ProfilePatch = Partial<
  Pick<User, "displayName" | "email" | "fullName" | "addressLine" | "city" | "postcode" | "country">
>;

export async function updateProfile(db: Db, userId: number, p: ProfilePatch): Promise<void> {
  const columns: Record<keyof ProfilePatch, string> = {
    displayName: "display_name",
    email: "email",
    fullName: "full_name",
    addressLine: "address_line",
    city: "city",
    postcode: "postcode",
    country: "country",
  };
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [key, column] of Object.entries(columns) as [keyof ProfilePatch, string][]) {
    if (p[key] !== undefined) {
      sets.push(`${column} = ?`);
      values.push(p[key] === "" ? null : p[key]);
    }
  }
  if (sets.length === 0) return;
  values.push(userId);
  await db.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, values);
}

// ----------------------------------------------------------------- sessions

export async function createSession(db: Db, userId: number, address: string): Promise<string> {
  const token = randomToken();
  await db.query(
    `INSERT INTO sessions (token, user_id, address, expires_at) VALUES (?, ?, ?, ?)`,
    [token, userId, address, Date.now() + SESSION_TTL_MS],
  );
  return token;
}

export async function sessionUser(
  db: Db,
  token: string,
): Promise<{ user: User; address: string } | undefined> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT user_id AS userId, address FROM sessions WHERE token = ? AND expires_at > ?`,
    [token, Date.now()],
  );
  const row = rows[0];
  if (!row) return undefined;
  const user = await userById(db, Number(row.userId));
  return user ? { user, address: row.address as string } : undefined;
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.query(`DELETE FROM sessions WHERE token = ?`, [token]);
}

// ------------------------------------------------------------------ history

export interface HistoryRow {
  policyId: string;
  tokenName: string;
  kind: "open" | "bid" | "settle";
  txHash: string;
  blockTime: number;
  amount: number | null;
  bidderAddress: string | null;
  /** True if this is still the standing bid on that auction. */
  standing: boolean;
  phase: "bidding" | "closed" | "settled";
  endTime: number;
}

/**
 * One user's activity, assembled from the chain rather than recorded by us.
 *
 * This is the point worth making in the thesis: a user's history here is
 * *verifiable*. Every row corresponds to a transaction they can look up on a
 * public explorer, and it was reconstructed from the ledger rather than written
 * down when the app felt like it. On a conventional auction site, history is
 * whatever the operator's database says it is.
 */
export async function historyFor(db: Db, userId: number): Promise<HistoryRow[]> {
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT e.policy_id      AS policyId,
            a.token_name     AS tokenName,
            e.kind           AS kind,
            e.tx_hash        AS txHash,
            e.block_time     AS blockTime,
            e.amount         AS amount,
            e.bidder_address AS bidderAddress,
            a.status         AS status,
            a.end_time       AS endTime,
            (e.id = (SELECT MAX(e2.id) FROM events e2
                      WHERE e2.policy_id = e.policy_id AND e2.kind = 'bid')) AS standing
       FROM events e
       JOIN auctions a          ON a.policy_id = e.policy_id
       JOIN wallet_addresses w  ON w.address   = e.bidder_address
      WHERE w.user_id = ? AND e.kind = 'bid'
      ORDER BY e.block_height DESC, e.id DESC`,
    [userId],
  );
  const now = Date.now();
  return rows.map((r) => ({
    policyId: r.policyId as string,
    tokenName: r.tokenName as string,
    kind: r.kind as HistoryRow["kind"],
    txHash: r.txHash as string,
    blockTime: Number(r.blockTime),
    amount: r.amount === null ? null : Number(r.amount),
    bidderAddress: r.bidderAddress as string | null,
    standing: Boolean(Number(r.standing)),
    phase: r.status === "settled" ? "settled" : now > Number(r.endTime) ? "closed" : "bidding",
    endTime: Number(r.endTime),
  }));
}

/**
 * Public display names for a set of addresses.
 *
 * **Only `display_name` ever leaves this table.** It is the one field a user
 * chooses in order to be seen; email, legal name, delivery address and KYC
 * status are not exposed by any endpoint that another user can read. Widening
 * this query is the easy way to turn a convenience into a data leak, so it
 * selects columns explicitly rather than `SELECT *`.
 *
 * A name is decoration over chain data, never a substitute for it. The address
 * is what the validator paid and what an explorer will confirm; the name is
 * what this site happens to know about who controls it. The API keeps both, and
 * the interface falls back to the address whenever a name is absent.
 */
export async function displayNames(
  db: Db,
  addresses: string[],
): Promise<Record<string, string>> {
  const wanted = [...new Set(addresses.filter(Boolean))];
  if (wanted.length === 0) return {};
  const [rows] = await db.query<RowDataPacket[]>(
    `SELECT w.address AS address, u.display_name AS name
       FROM wallet_addresses w
       JOIN users u ON u.id = w.user_id
      WHERE u.display_name IS NOT NULL
        AND w.address IN (${wanted.map(() => "?").join(",")})`,
    wanted,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[r.address as string] = r.name as string;
  return out;
}
