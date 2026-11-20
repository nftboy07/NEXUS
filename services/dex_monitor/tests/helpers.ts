// Test fakes for Engine 4: in-memory DexStore, recorded alert sink, and
// helpers to wrap real recorded RPC logs into NexusNormalizedEvent shape.

import { readFileSync } from "node:fs";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { DexStore, LiquidityEventRow, PoolRow, ReserveRow } from "../src/store.js";
import type { AlertRecord, AlertSink } from "../src/alerts.js";
import { poolId } from "../src/store.js";

export interface RawRpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  blockHash: string;
  logIndex: string;
  transactionIndex?: string;
  removed?: boolean;
}

export function loadRawLogs(): Record<string, RawRpcLog> {
  return JSON.parse(
    readFileSync(new URL("./fixtures/raw_logs.json", import.meta.url), "utf8")
  ) as Record<string, RawRpcLog>;
}

/** Wrap a recorded RPC log into the NexusNormalizedEvent Engine 1 publishes. */
export function toNormalizedEvent(raw: RawRpcLog, chainId: number): NexusNormalizedEvent {
  const blockNumber = parseInt(raw.blockNumber, 16);
  const logIndex = parseInt(raw.logIndex, 16);
  return {
    chain_id: chainId,
    kind: "log",
    dedup_key: `${chainId}:${raw.blockHash}:${raw.transactionHash}:${logIndex}`,
    block_number: blockNumber,
    block_hash: raw.blockHash,
    tx_hash: raw.transactionHash,
    log_index: logIndex,
    payload: {
      contract: raw.address,
      topics: raw.topics,
      data: raw.data,
      transaction_index: raw.transactionIndex ? parseInt(raw.transactionIndex, 16) : null,
      removed: raw.removed ?? false,
    },
  };
}

/** Synthetic normalized log event for controlled-amount tests. */
export function syntheticLogEvent(opts: {
  chainId: number;
  contract: string;
  topics: string[];
  data: string;
  block: number;
  txHash: string;
  logIndex?: number;
}): NexusNormalizedEvent {
  const logIndex = opts.logIndex ?? 0;
  const blockHash = "0x" + opts.block.toString(16).padStart(64, "0");
  return {
    chain_id: opts.chainId,
    kind: "log",
    dedup_key: `${opts.chainId}:${blockHash}:${opts.txHash}:${logIndex}`,
    block_number: opts.block,
    block_hash: blockHash,
    tx_hash: opts.txHash,
    log_index: logIndex,
    payload: {
      contract: opts.contract,
      topics: opts.topics,
      data: opts.data,
      transaction_index: 0,
      removed: false,
    },
  };
}

export class FakeDexStore implements DexStore {
  pools = new Map<string, PoolRow>();
  liquidityEvents: LiquidityEventRow[] = [];
  reserves: ReserveRow[] = [];
  alerts: { dedupKey?: string; destination: string; message: string }[] = [];
  txSenders = new Map<string, string>();

  async upsertPool(p: PoolRow): Promise<void> {
    if (!this.pools.has(p.id)) this.pools.set(p.id, { ...p });
  }
  async getPool(chainId: number, address: string): Promise<PoolRow | null> {
    return this.pools.get(poolId(chainId, address)) ?? null;
  }
  async insertLiquidityEvent(e: LiquidityEventRow): Promise<void> {
    // idempotent on (pool, tx, block, type, amounts)
    const dup = this.liquidityEvents.some(
      (x) =>
        x.poolId === e.poolId &&
        x.txHash === e.txHash &&
        x.blockNumber === e.blockNumber &&
        x.eventType === e.eventType &&
        x.amount0 === e.amount0 &&
        x.amount1 === e.amount1
    );
    if (!dup) this.liquidityEvents.push({ ...e });
  }
  async insertPoolReserve(r: ReserveRow): Promise<void> {
    const dup = this.reserves.some((x) => x.poolId === r.poolId && x.blockNumber === r.blockNumber);
    if (!dup) this.reserves.push({ ...r });
  }
  async deleteByBlock(chainId: number, blockHash: string): Promise<void> {
    this.liquidityEvents = this.liquidityEvents.filter(
      (e) => !(e.blockHash === blockHash && e.poolId.startsWith(`${chainId}:`))
    );
    this.reserves = this.reserves.filter((r) => !(r.blockHash === blockHash && r.chainId === chainId));
    for (const [id, p] of [...this.pools]) {
      if (p.blockHash === blockHash && p.chainId === chainId) this.pools.delete(id);
    }
  }
  async latestReserve(pid: string): Promise<ReserveRow | null> {
    const rows = this.reserves.filter((r) => r.poolId === pid && r.reserve0 !== null);
    return rows.sort((a, b) => (a.blockNumber < b.blockNumber ? 1 : -1))[0] ?? null;
  }
  async netLiquidity(pid: string): Promise<{ amount0: bigint; amount1: bigint }> {
    let a0 = 0n, a1 = 0n;
    for (const e of this.liquidityEvents.filter((x) => x.poolId === pid)) {
      if (e.eventType === "add") {
        a0 += BigInt(e.amount0);
        a1 += BigInt(e.amount1);
      } else if (e.eventType === "remove") {
        a0 -= BigInt(e.amount0);
        a1 -= BigInt(e.amount1);
      }
    }
    return { amount0: a0, amount1: a1 };
  }
  async sumEvents(pid: string, eventType: string, _sinceTs: number): Promise<{ amount0: bigint; amount1: bigint }> {
    // fake ignores the time window — tests seed only the events they want counted
    let a0 = 0n, a1 = 0n;
    for (const e of this.liquidityEvents.filter((x) => x.poolId === pid && x.eventType === eventType)) {
      a0 += BigInt(e.amount0);
      a1 += BigInt(e.amount1);
    }
    return { amount0: a0, amount1: a1 };
  }
  async poolActivity(pid: string): Promise<{ events: number; lastBlock: bigint | null }> {
    const rows = this.liquidityEvents.filter((x) => x.poolId === pid);
    return {
      events: rows.length,
      lastBlock: rows.length ? rows.map((r) => r.blockNumber).reduce((a, b) => (a > b ? a : b)) : null,
    };
  }
  async countPriorRemovals(_chainId: number, pid: string, sender: string, beforeBlock: bigint): Promise<number> {
    return this.liquidityEvents.filter(
      (e) =>
        e.poolId === pid &&
        e.eventType === "remove" &&
        e.blockNumber < beforeBlock &&
        this.txSenders.get(e.txHash) === sender.toLowerCase()
    ).length;
  }
  async getTransactionSender(chainId: number, txHash: string): Promise<string | null> {
    return this.txSenders.get(`${chainId}:${txHash}`) ?? null;
  }
  async hasAlert(dedupKey: string): Promise<boolean> {
    return this.alerts.some((a) => a.dedupKey === dedupKey);
  }
  async insertAlert(record: { dedupKey: string; sourceEngine: string; kind: string; chainId: number; destination: string; message: string }): Promise<boolean> {
    if (await this.hasAlert(record.dedupKey)) return false;
    this.alerts.push({ dedupKey: record.dedupKey, destination: record.destination, message: record.message });
    return true;
  }
  async close(): Promise<void> {}
}

export class FakeAlertSink implements AlertSink {
  records: AlertRecord[] = [];
  async emit(record: AlertRecord): Promise<void> {
    this.records.push(record);
  }
}
