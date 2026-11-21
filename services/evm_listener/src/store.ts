// Postgres writes for blocks, logs, transactions against migrations/001_init.sql.
// All inserts are idempotent: ON CONFLICT DO NOTHING keyed on the schema PKs.

import type { Pool, PoolClient } from "pg";

export interface StoredBlock {
  chainId: number;
  number: bigint;
  hash: string;
  parentHash: string | null;
  timestamp: bigint | null;
}

export interface StoredLog {
  chainId: number;
  blockHash: string;
  transactionHash: string;
  logIndex: number;
  contract: string | null;
  topics: string[];
  data: string;
  removed?: boolean;
}

export interface StoredTransaction {
  chainId: number;
  hash: string;
  sender: string | null;
  recipient: string | null;
  value: string | null;
  status: string | null;
  blockNumber: bigint | null;
  /** nonce + block_hash columns are added by migration 002 (Engine 2 needs
   * them for REPLACED/REORGED detection). */
  nonce?: bigint | null;
  blockHash?: string | null;
}

export interface Checkpoint {
  chainId: number;
  lastBlock: bigint;
  lastLogCursor: string | null;
}

export type UpsertResult = "inserted" | "duplicate";

export interface EventStore {
  upsertBlock(block: StoredBlock): Promise<UpsertResult>;
  upsertLog(log: StoredLog): Promise<UpsertResult>;
  upsertTransaction(tx: StoredTransaction): Promise<UpsertResult>;
  /** Batch upsert (one round trip); results align with input order.
   * Optional — callers fall back to per-row upsertLog. */
  upsertLogs?(logs: StoredLog[]): Promise<UpsertResult[]>;
  /** Batch upsertTransaction (one round trip). Optional. */
  upsertTransactions?(txs: StoredTransaction[]): Promise<void>;
  markLogsRemoved(chainId: number, blockHash: string): Promise<number>;
  /** Insert a removed-block marker (removed_blocks); false when already present. */
  insertRemovedBlock(chainId: number, blockHash: string): Promise<boolean>;
  /** Which of `hashes` already have a transactions row on this chain. */
  existingTransactions(chainId: number, hashes: string[]): Promise<Set<string>>;
  getBlockByNumber(chainId: number, number: bigint): Promise<StoredBlock[]>;
  getCheckpoint(chainId: number): Promise<Checkpoint | null>;
  setCheckpoint(chainId: number, lastBlock: bigint, lastLogCursor: string | null): Promise<void>;
  /** Watchlist wallet addresses (watchlists.kind = 'wallet') — scoped filters. */
  watchlistWallets(): Promise<string[]>;
  /** Registered pool addresses for a chain (pools table) — scoped filters. */
  poolAddresses(chainId: number): Promise<string[]>;
  recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void>;
  close(): Promise<void>;
}

export class PgStore implements EventStore {
  constructor(private pool: Pool | PoolClient) {}

  async upsertBlock(b: StoredBlock): Promise<UpsertResult> {
    const res = await this.pool.query(
      `INSERT INTO blocks (chain_id, number, hash, parent_hash, ts)
       VALUES ($1,$2,$3,$4, to_timestamp($5))
       ON CONFLICT (chain_id, hash) DO NOTHING`,
      [b.chainId, b.number.toString(), b.hash, b.parentHash, b.timestamp?.toString() ?? null]
    );
    return res.rowCount === 0 ? "duplicate" : "inserted";
  }

  async upsertLog(l: StoredLog): Promise<UpsertResult> {
    const res = await this.pool.query(
      `INSERT INTO logs (chain_id, block_hash, transaction_hash, log_index, contract, topics, data, removed)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (chain_id, block_hash, transaction_hash, log_index) DO NOTHING`,
      [l.chainId, l.blockHash, l.transactionHash, l.logIndex, l.contract, JSON.stringify(l.topics), l.data, l.removed ?? false]
    );
    return res.rowCount === 0 ? "duplicate" : "inserted";
  }

  async upsertTransaction(t: StoredTransaction): Promise<UpsertResult> {
    const res = await this.pool.query(
      `INSERT INTO transactions (chain_id, hash, sender, recipient, value, status, block_number, nonce, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (chain_id, hash) DO UPDATE
       SET nonce = COALESCE(EXCLUDED.nonce, transactions.nonce),
           block_hash = COALESCE(EXCLUDED.block_hash, transactions.block_hash)`,
      [t.chainId, t.hash, t.sender, t.recipient, t.value, t.status, t.blockNumber?.toString() ?? null,
       t.nonce?.toString() ?? null, t.blockHash ?? null]
    );
    return res.rowCount === 0 ? "duplicate" : "inserted";
  }

  async upsertLogs(logs: StoredLog[]): Promise<UpsertResult[]> {
    if (logs.length === 0) return [];
    const res = await this.pool.query(
      `INSERT INTO logs (chain_id, block_hash, transaction_hash, log_index, contract, topics, data, removed)
       SELECT $1, t.* FROM unnest($2::text[], $3::text[], $4::int[], $5::text[], $6::jsonb[], $7::text[], $8::bool[]) AS t
       ON CONFLICT (chain_id, block_hash, transaction_hash, log_index) DO NOTHING
       RETURNING block_hash, transaction_hash, log_index`,
      [
        logs[0].chainId,
        logs.map((l) => l.blockHash),
        logs.map((l) => l.transactionHash),
        logs.map((l) => l.logIndex),
        logs.map((l) => l.contract),
        logs.map((l) => JSON.stringify(l.topics)),
        logs.map((l) => l.data),
        logs.map((l) => l.removed ?? false),
      ]
    );
    const key = (b: string, t: string, i: number) => `${b}:${t}:${i}`;
    const inserted = new Set(
      res.rows.map((r: { block_hash: string; transaction_hash: string; log_index: number }) =>
        key(r.block_hash, r.transaction_hash, r.log_index))
    );
    // A key repeated inside one batch is inserted once: only its first occurrence counts.
    const seen = new Set<string>();
    return logs.map((l) => {
      const k = key(l.blockHash, l.transactionHash, l.logIndex);
      const first = !seen.has(k);
      seen.add(k);
      return first && inserted.has(k) ? "inserted" : "duplicate";
    });
  }

  async upsertTransactions(txs: StoredTransaction[]): Promise<void> {
    // ON CONFLICT DO UPDATE rejects a key twice in one statement: last row wins.
    const byHash = new Map(txs.map((t) => [t.hash, t]));
    const rows = [...byHash.values()];
    if (rows.length === 0) return;
    await this.pool.query(
      `INSERT INTO transactions (chain_id, hash, sender, recipient, value, status, block_number, nonce, block_hash)
       SELECT $1, t.* FROM unnest($2::text[], $3::text[], $4::text[], $5::numeric[], $6::text[], $7::bigint[], $8::bigint[], $9::text[]) AS t
       ON CONFLICT (chain_id, hash) DO UPDATE
       SET nonce = COALESCE(EXCLUDED.nonce, transactions.nonce),
           block_hash = COALESCE(EXCLUDED.block_hash, transactions.block_hash)`,
      [
        rows[0].chainId,
        rows.map((t) => t.hash),
        rows.map((t) => t.sender),
        rows.map((t) => t.recipient),
        rows.map((t) => t.value),
        rows.map((t) => t.status),
        rows.map((t) => t.blockNumber?.toString() ?? null),
        rows.map((t) => t.nonce?.toString() ?? null),
        rows.map((t) => t.blockHash ?? null),
      ]
    );
  }

  async existingTransactions(chainId: number, hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const res = await this.pool.query(
      `SELECT hash FROM transactions WHERE chain_id = $1 AND hash = ANY($2)`,
      [chainId, hashes]
    );
    return new Set(res.rows.map((r: { hash: string }) => r.hash));
  }

  async markLogsRemoved(chainId: number, blockHash: string): Promise<number> {
    const res = await this.pool.query(
      `UPDATE logs SET removed = TRUE WHERE chain_id = $1 AND block_hash = $2 AND removed = FALSE`,
      [chainId, blockHash]
    );
    return res.rowCount ?? 0;
  }

  async insertRemovedBlock(chainId: number, blockHash: string): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO removed_blocks (chain_id, block_hash) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [chainId, blockHash]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getBlockByNumber(chainId: number, number: bigint): Promise<StoredBlock[]> {
    const res = await this.pool.query(
      `SELECT chain_id, number, hash, parent_hash, ts FROM blocks WHERE chain_id = $1 AND number = $2`,
      [chainId, number.toString()]
    );
    return res.rows.map((r) => ({
      chainId: r.chain_id,
      number: BigInt(r.number),
      hash: r.hash,
      parentHash: r.parent_hash,
      timestamp: r.ts ? BigInt(Math.floor(new Date(r.ts).getTime() / 1000)) : null,
    }));
  }

  async getCheckpoint(chainId: number): Promise<Checkpoint | null> {
    const res = await this.pool.query(
      `SELECT chain_id, last_block, last_log_cursor FROM checkpoints WHERE chain_id = $1`,
      [chainId]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return { chainId: r.chain_id, lastBlock: BigInt(r.last_block), lastLogCursor: r.last_log_cursor };
  }

  async setCheckpoint(chainId: number, lastBlock: bigint, lastLogCursor: string | null): Promise<void> {
    await this.pool.query(
      `INSERT INTO checkpoints (chain_id, last_block, last_log_cursor, updated_at)
       VALUES ($1,$2,$3, now())
       ON CONFLICT (chain_id) DO UPDATE SET last_block = $2, last_log_cursor = $3, updated_at = now()`,
      [chainId, lastBlock.toString(), lastLogCursor]
    );
  }

  async watchlistWallets(): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT value FROM watchlists WHERE kind = 'wallet'`
    );
    return res.rows.map((r) => r.value.toLowerCase());
  }

  async poolAddresses(chainId: number): Promise<string[]> {
    const res = await this.pool.query(
      `SELECT id FROM pools WHERE chain_id = $1`, [chainId]
    );
    // pools.id is "<chain_id>:<address>" (dex_monitor poolId); filters need the bare address.
    return res.rows.map((r) => String(r.id).split(":").pop()!.toLowerCase());
  }

  async recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_health (provider, chain_id, latency_ms, errors) VALUES ($1,$2,$3,$4)`,
      [row.provider, row.chainId, row.latencyMs, row.errors]
    );
  }

  async close(): Promise<void> {
    if ("end" in this.pool && typeof this.pool.end === "function") await this.pool.end();
  }
}
