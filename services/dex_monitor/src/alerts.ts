// Liquidity-removal alerts: single removal >= LIQ_REMOVAL_ALERT_PCT (default
// 20) of the pool's net liquidity -> alerts table row + nexus:alerts record.
// Facts per BLUEPRINT §6. Idempotent: one alert per removal dedup_key.

import type { Logger } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { DexStore, PoolRow } from "./store.js";

export const ALERTS_STREAM = "nexus:alerts";

export interface AlertRecord {
  source: "dex_monitor";
  kind: "liquidity_removal";
  chain_id: number;
  dedup_key: string;
  facts: {
    pool_id: string;
    dex: string;
    wallet: string | null;
    wallet_source: string;
    tx_hash: string | null;
    block_number: number | null;
    removed_amount0: string;
    removed_amount1: string;
    removal_pct: number;
    estimated_value: string;
    valuation_source: string;
    remaining_amount0: string;
    remaining_amount1: string;
    prior_similar_actions: number;
  };
}

export interface AlertSink {
  /** alerts table row + nexus:alerts XADD. Caller checks hasAlert first for dedup. */
  emit(record: AlertRecord): Promise<void>;
}

export class DbStreamAlertSink implements AlertSink {
  constructor(
    private store: DexStore,
    private xadd: (stream: string, fields: Record<string, string>) => Promise<unknown>
  ) {}

  async emit(record: AlertRecord): Promise<void> {
    const message = JSON.stringify(record);
    await this.store.insertAlert("nexus:alerts", message);
    await this.xadd(ALERTS_STREAM, {
      dedup_key: record.dedup_key,
      source: record.source,
      kind: record.kind,
      chain_id: String(record.chain_id),
      record: message,
    });
  }
}

export interface RemovalAlertInput {
  ev: NexusNormalizedEvent;
  pool: PoolRow;
  poolAddress: string;
  sender: string; // Burn sender arg
  removed0: bigint;
  removed1: bigint;
  net0Before: bigint;
  net1Before: bigint;
  thresholdPct: number;
  sink: AlertSink;
  store: DexStore;
  log: Logger;
}

/** Emits exactly one alert per removal dedup_key when over threshold. */
export async function maybeAlertRemoval(input: RemovalAlertInput): Promise<AlertRecord | null> {
  const { ev, pool, store, sink, log, thresholdPct } = input;
  const frac = Math.max(
    input.net0Before > 0n ? Number(input.removed0) / Number(input.net0Before) : 0,
    input.net1Before > 0n ? Number(input.removed1) / Number(input.net1Before) : 0
  );
  if (frac * 100 < thresholdPct) return null;
  if (await store.hasAlert(ev.dedup_key)) {
    log.info("alert already emitted for removal", { dedup_key: ev.dedup_key });
    return null;
  }

  const txSender = ev.tx_hash ? await store.getTransactionSender(ev.chain_id, ev.tx_hash) : null;
  const wallet = txSender ?? input.sender;
  const prior = ev.tx_hash
    ? await store.countPriorRemovals(ev.chain_id, pool.id, wallet, BigInt(ev.block_number ?? 0))
    : 0;

  const record: AlertRecord = {
    source: "dex_monitor",
    kind: "liquidity_removal",
    chain_id: ev.chain_id,
    dedup_key: ev.dedup_key,
    facts: {
      pool_id: pool.id,
      dex: pool.dex,
      wallet,
      wallet_source: txSender ? "transactions.sender (engine 1)" : "burn event sender arg",
      tx_hash: ev.tx_hash,
      block_number: ev.block_number,
      removed_amount0: input.removed0.toString(),
      removed_amount1: input.removed1.toString(),
      removal_pct: frac * 100,
      estimated_value: `${input.removed0} token0 + ${input.removed1} token1 (raw units)`,
      valuation_source: "none — token units only; no price feed configured",
      remaining_amount0: (input.net0Before - input.removed0).toString(),
      remaining_amount1: (input.net1Before - input.removed1).toString(),
      prior_similar_actions: prior,
    },
  };
  await sink.emit(record);
  log.warn("liquidity removal alert", {
    pool_id: pool.id,
    removal_pct: record.facts.removal_pct,
    tx_hash: ev.tx_hash,
  });
  return record;
}
