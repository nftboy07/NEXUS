// Postgres persistence for Engine 4. DexStore is injectable so tests use
// fakes; production uses PgDexStore against 001_init.sql + 004_pool_reserves.sql.

import type { Pool, PoolClient } from "pg";

export interface PoolRow {
  id: string; // chain_id:pool_address
  dex: string;
  token0: string;
  token1: string;
  chainId: number;
  feeTier: number | null;
  createdBlock: bigint | null;
  createdTx: string | null;
  /** Block hash of the PoolCreated event; set by migration 007 consumers. */
  blockHash?: string | null;
  /** 'pool_created' (seen PoolCreated event) or 'lazy' (RPC-probed). */
  discovery?: string;
}

export interface LiquidityEventRow {
  poolId: string;
  chainId: number;
  eventType: "add" | "remove" | "swap";
  amount0: string;
  amount1: string;
  txHash: string;
  blockNumber: bigint;
  blockHash?: string | null;
}

export interface ReserveRow {
  poolId: string;
  chainId: number;
  reserve0: string | null;
  reserve1: string | null;
  source: "sync" | "swap_derived" | "partial";
  blockNumber: bigint;
  blockHash?: string | null;
}

export interface DexStore {
  upsertPool(p: PoolRow): Promise<void>;
  getPool(chainId: number, address: string): Promise<PoolRow | null>;
  insertLiquidityEvent(e: LiquidityEventRow): Promise<void>;
  insertPoolReserve(r: ReserveRow): Promise<void>;
  latestReserve(poolId: string): Promise<ReserveRow | null>;
  /** net token amounts in the pool: adds - removes, all time */
  netLiquidity(poolId: string): Promise<{ amount0: bigint; amount1: bigint }>;
  /** sum of a token-side amount for an event type since a unix-ts (seconds) */
  sumEvents(poolId: string, eventType: string, sinceTs: number): Promise<{ amount0: bigint; amount1: bigint }>;
  /** total events count + max block for a pool (age/activity metric) */
  poolActivity(poolId: string): Promise<{ events: number; lastBlock: bigint | null }>;
  /** count prior 'remove' events initiated by the same wallet (tx sender join) */
  countPriorRemovals(chainId: number, poolId: string, sender: string, beforeBlock: bigint): Promise<number>;
  /** tx sender from Engine 1's transactions table, if populated */
  getTransactionSender(chainId: number, txHash: string): Promise<string | null>;
  hasAlert(dedupKey: string): Promise<boolean>;
  /** Returns true when the row was inserted (dedup_key did not exist). */
  insertAlert(record: { dedupKey: string; sourceEngine: string; kind: string; chainId: number; destination: string; message: string }): Promise<boolean>;
  /** Delete rows derived from an orphaned block (reorg propagation). */
  deleteByBlock(chainId: number, blockHash: string): Promise<void>;
  close(): Promise<void>;
}

export function poolId(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

export class PgDexStore implements DexStore {
  constructor(private pool: Pool | PoolClient) {}

  async upsertPool(p: PoolRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO pools (id, dex, token0, token1, chain_id, fee_tier, created_block, created_tx, block_hash, discovery)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO NOTHING`,
      [p.id, p.dex, p.token0, p.token1, p.chainId, p.feeTier, p.createdBlock?.toString() ?? null, p.createdTx, p.blockHash ?? null, p.discovery ?? "pool_created"]
    );
  }

  async getPool(chainId: number, address: string): Promise<PoolRow | null> {
    const res = await this.pool.query(
      `SELECT id, dex, token0, token1, chain_id, fee_tier, created_block, created_tx FROM pools
       WHERE chain_id = $1 AND id = $2`,
      [chainId, poolId(chainId, address)]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: r.id,
      dex: r.dex,
      token0: r.token0,
      token1: r.token1,
      chainId: r.chain_id,
      feeTier: r.fee_tier,
      createdBlock: r.created_block === null ? null : BigInt(r.created_block),
      createdTx: r.created_tx,
    };
  }

  async insertLiquidityEvent(e: LiquidityEventRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO liquidity_events (pool_id, chain_id, event_type, amount0, amount1, tx_hash, block_number, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [e.poolId, e.chainId, e.eventType, e.amount0, e.amount1, e.txHash, e.blockNumber.toString(), e.blockHash ?? null]
    );
  }

  async insertPoolReserve(r: ReserveRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO pool_reserves (pool_id, chain_id, reserve0, reserve1, source, block_number, block_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (pool_id, block_number) DO NOTHING`,
      [r.poolId, r.chainId, r.reserve0, r.reserve1, r.source, r.blockNumber.toString(), r.blockHash ?? null]
    );
  }

  async latestReserve(pid: string): Promise<ReserveRow | null> {
    const res = await this.pool.query(
      `SELECT * FROM pool_reserves WHERE pool_id = $1 AND reserve0 IS NOT NULL ORDER BY block_number DESC LIMIT 1`,
      [pid]
    );
    if (res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      poolId: r.pool_id,
      chainId: r.chain_id,
      reserve0: r.reserve0,
      reserve1: r.reserve1,
      source: r.source,
      blockNumber: BigInt(r.block_number),
    };
  }

  async netLiquidity(pid: string): Promise<{ amount0: bigint; amount1: bigint }> {
    const res = await this.pool.query(
      `SELECT
         COALESCE(SUM(CASE WHEN event_type = 'add' THEN amount0 END),0)
         - COALESCE(SUM(CASE WHEN event_type = 'remove' THEN amount0 END),0) AS a0,
         COALESCE(SUM(CASE WHEN event_type = 'add' THEN amount1 END),0)
         - COALESCE(SUM(CASE WHEN event_type = 'remove' THEN amount1 END),0) AS a1
       FROM liquidity_events WHERE pool_id = $1`,
      [pid]
    );
    return { amount0: BigInt(res.rows[0].a0), amount1: BigInt(res.rows[0].a1) };
  }

  async sumEvents(pid: string, eventType: string, sinceTs: number): Promise<{ amount0: bigint; amount1: bigint }> {
    const res = await this.pool.query(
      `SELECT COALESCE(SUM(amount0),0) AS a0, COALESCE(SUM(amount1),0) AS a1
       FROM liquidity_events WHERE pool_id = $1 AND event_type = $2 AND ts >= to_timestamp($3)`,
      [pid, eventType, sinceTs]
    );
    return { amount0: BigInt(res.rows[0].a0), amount1: BigInt(res.rows[0].a1) };
  }

  async poolActivity(pid: string): Promise<{ events: number; lastBlock: bigint | null }> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n, MAX(block_number) AS mb FROM liquidity_events WHERE pool_id = $1`,
      [pid]
    );
    return { events: res.rows[0].n, lastBlock: res.rows[0].mb === null ? null : BigInt(res.rows[0].mb) };
  }

  async countPriorRemovals(chainId: number, pid: string, sender: string, beforeBlock: bigint): Promise<number> {
    const res = await this.pool.query(
      `SELECT COUNT(*)::int AS n FROM liquidity_events le
       JOIN transactions t ON t.chain_id = $1 AND t.hash = le.tx_hash
       WHERE le.pool_id = $2 AND le.event_type = 'remove' AND t.sender = $3 AND le.block_number < $4`,
      [chainId, pid, sender.toLowerCase(), beforeBlock.toString()]
    );
    return res.rows[0].n;
  }

  async getTransactionSender(chainId: number, txHash: string): Promise<string | null> {
    const res = await this.pool.query(
      `SELECT sender FROM transactions WHERE chain_id = $1 AND hash = $2`,
      [chainId, txHash]
    );
    return res.rows[0]?.sender ?? null;
  }

  async hasAlert(dedupKey: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1 FROM alerts WHERE dedup_key = $1 LIMIT 1`,
      [dedupKey]
    );
    return res.rows.length > 0;
  }

  async deleteByBlock(chainId: number, blockHash: string): Promise<void> {
    for (const table of ["liquidity_events", "pool_reserves", "pools"] as const) {
      await this.pool.query(`DELETE FROM ${table} WHERE chain_id = $1 AND block_hash = $2`, [chainId, blockHash]);
    }
  }

  async insertAlert(record: { dedupKey: string; sourceEngine: string; kind: string; chainId: number; destination: string; message: string }): Promise<boolean> {
    const res = await this.pool.query(
      `INSERT INTO alerts (dedup_key, source_engine, kind, chain_id, record, destination, message, delivery_state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
       ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL DO NOTHING`,
      [record.dedupKey, record.sourceEngine, record.kind, record.chainId, record.message, record.destination, record.message]
    );
    return (res.rowCount ?? 0) > 0;
  }

  async close(): Promise<void> {
    if ("end" in this.pool && typeof this.pool.end === "function") await this.pool.end();
  }
}
