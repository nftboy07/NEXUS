// Postgres persistence for pending_transactions + read-only lookups into
// Engine 1's tables (transactions, checkpoints, blocks) for inclusion and
// reorg resolution. PendingStore is injectable; production uses PgPendingStore.

import type { Pool, PoolClient } from "pg";
import type { DecodedTx } from "./decoder.js";

export type PendingStatus =
  | "DETECTED" | "PENDING" | "INCLUDED" | "REPLACED" | "DROPPED" | "CONFIRMED" | "REORGED";

export interface PendingRow {
  chainId: number;
  hash: string;
  sender: string | null;
  nonce: bigint | null;
  recipient: string | null;
  value: string | null;
  method: string | null;
  decoded: DecodedTx | null;
  status: PendingStatus;
  firstSeenBlock: bigint | null;
  includedBlock: bigint | null;
  /** Set when inclusion was proven by receipt (no transactions row needed). */
  includedBlockHash?: string | null;
  replacedBy: string | null;
  watchlistMatch?: string | null;
}

export interface IncludedTx {
  hash: string;
  sender: string | null;
  nonce: bigint | null;
  blockNumber: bigint | null;
  blockHash: string | null;
}

export interface PendingStore {
  upsertPending(row: PendingRow): Promise<void>;
  transition(chainId: number, hash: string, status: PendingStatus, fields?: Partial<PendingRow>): Promise<void>;
  pendingByStatus(chainId: number, statuses: PendingStatus[]): Promise<PendingRow[]>;
  setWatchlistMatch(chainId: number, hash: string, match: string): Promise<void>;
  /** Included (canonical) tx row, or null. */
  getIncluded(chainId: number, hash: string): Promise<IncludedTx | null>;
  /** Included tx with same sender+nonce but different hash — replacement. */
  findReplacement(chainId: number, sender: string, nonce: bigint, excludeHash: string): Promise<IncludedTx | null>;
  /** Engine 1 checkpoint head for the chain (last fully processed block). */
  checkpoint(chainId: number): Promise<bigint | null>;
  /** Is block `number`/`hash` still canonical per the blocks table? */
  isCanonicalBlock(chainId: number, number: bigint, hash: string): Promise<boolean>;
  recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void>;
  close(): Promise<void>;
}

export class PgPendingStore implements PendingStore {
  constructor(private pool: Pool | PoolClient) {}

  async upsertPending(r: PendingRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_transactions
         (chain_id, hash, sender, nonce, recipient, value, method, decoded, status, first_seen_block)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (chain_id, hash) DO UPDATE SET updated_at = now()`,
      [r.chainId, r.hash, r.sender, r.nonce?.toString() ?? null, r.recipient, r.value,
       r.method, r.decoded ? JSON.stringify(r.decoded) : null, r.status, r.firstSeenBlock?.toString() ?? null]
    );
  }

  async transition(chainId: number, hash: string, status: PendingStatus, f: Partial<PendingRow> = {}): Promise<void> {
    await this.pool.query(
      `UPDATE pending_transactions SET status=$3, updated_at=now(),
         included_block = COALESCE($4, included_block),
         replaced_by = COALESCE($5, replaced_by),
         sender = COALESCE($6, sender),
         nonce = COALESCE($7, nonce),
         recipient = COALESCE($8, recipient),
         value = COALESCE($9, value),
         method = COALESCE($10, method),
         decoded = COALESCE($11, decoded),
         included_block_hash = COALESCE($12, included_block_hash)
       WHERE chain_id=$1 AND hash=$2`,
      [chainId, hash, status, f.includedBlock?.toString() ?? null, f.replacedBy ?? null,
       f.sender ?? null, f.nonce?.toString() ?? null, f.recipient ?? null,
       f.value ?? null, f.method ?? null, f.decoded ? JSON.stringify(f.decoded) : null,
       f.includedBlockHash ?? null]
    );
  }

  async pendingByStatus(chainId: number, statuses: PendingStatus[]): Promise<PendingRow[]> {
    const res = await this.pool.query(
      `SELECT chain_id, hash, sender, nonce, recipient, value, method, decoded, status,
              first_seen_block, included_block, included_block_hash, replaced_by
       FROM pending_transactions WHERE chain_id=$1 AND status = ANY($2)`,
      [chainId, statuses]
    );
    return res.rows.map((r) => ({
      chainId: r.chain_id, hash: r.hash, sender: r.sender,
      nonce: r.nonce === null ? null : BigInt(r.nonce),
      recipient: r.recipient, value: r.value === null ? null : String(r.value),
      method: r.method, decoded: r.decoded, status: r.status,
      firstSeenBlock: r.first_seen_block === null ? null : BigInt(r.first_seen_block),
      includedBlock: r.included_block === null ? null : BigInt(r.included_block),
      includedBlockHash: r.included_block_hash,
      replacedBy: r.replaced_by,
    }));
  }

  async setWatchlistMatch(chainId: number, hash: string, match: string): Promise<void> {
    await this.pool.query(
      `UPDATE pending_transactions SET decoded = COALESCE(decoded,'{}'::jsonb) || $3::jsonb, updated_at=now()
       WHERE chain_id=$1 AND hash=$2`,
      [chainId, hash, JSON.stringify({ watchlist_match: match })]
    );
  }

  async getIncluded(chainId: number, hash: string): Promise<IncludedTx | null> {
    const res = await this.pool.query(
      `SELECT hash, sender, nonce, block_number, block_hash FROM transactions
       WHERE chain_id=$1 AND hash=$2`,
      [chainId, hash]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      hash: r.hash, sender: r.sender,
      nonce: r.nonce === null ? null : BigInt(r.nonce),
      blockNumber: r.block_number === null ? null : BigInt(r.block_number),
      blockHash: r.block_hash,
    };
  }

  async findReplacement(chainId: number, sender: string, nonce: bigint, excludeHash: string): Promise<IncludedTx | null> {
    const res = await this.pool.query(
      `SELECT hash, sender, nonce, block_number, block_hash FROM transactions
       WHERE chain_id=$1 AND sender=$2 AND nonce=$3 AND hash<>$4 LIMIT 1`,
      [chainId, sender, nonce.toString(), excludeHash]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      hash: r.hash, sender: r.sender,
      nonce: r.nonce === null ? null : BigInt(r.nonce),
      blockNumber: r.block_number === null ? null : BigInt(r.block_number),
      blockHash: r.block_hash,
    };
  }

  async checkpoint(chainId: number): Promise<bigint | null> {
    const res = await this.pool.query(`SELECT last_block FROM checkpoints WHERE chain_id=$1`, [chainId]);
    return res.rows.length === 0 ? null : BigInt(res.rows[0].last_block);
  }

  async isCanonicalBlock(chainId: number, _number: bigint, hash: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM blocks WHERE chain_id=$1 AND hash=$2`,
      [chainId, hash]
    );
    return res.rows.length > 0;
  }

  async recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void> {
    await this.pool.query(
      `INSERT INTO provider_health (provider, chain_id, latency_ms, errors) VALUES ($1,$2,$3,$4)`,
      [row.provider, row.chainId, row.latencyMs, row.errors]
    );
  }

  async close(): Promise<void> {}
}
