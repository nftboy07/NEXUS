// Liquidity Risk Radar (BLUEPRINT §6): transparent, multi-metric — every
// metric ships its value + inputs + data source; null when data is missing.
// No single-metric verdicts, no safe/unsafe labels.

import type { DexStore, PoolRow } from "./store.js";
import { estimateImpact } from "./impact.js";

export interface Metric<T = unknown> {
  value: T | null;
  inputs: Record<string, unknown>;
  source: string;
}

export interface RiskReport {
  pool_id: string;
  chain_id: number;
  dex: string;
  metrics: {
    /** reserve size in raw token units (no USD oracle on a $0 budget) */
    depth: Metric<{ reserve0: string; reserve1: string }>;
    /** largest LP share — LP token holder data is not collected in this engine */
    lp_concentration: Metric<never>;
    /** removals over the last 24h as % of net liquidity */
    withdrawal_24h_pct: Metric<number>;
    /** 24h swap volume (token0 units) / latest reserve0 */
    volume_liquidity_ratio: Metric<number>;
    /** pool-token holder concentration — not collected */
    holder_concentration: Metric<never>;
    /** age in blocks since creation + observed event count */
    age_and_activity: Metric<{ age_blocks: string | null; observed_events: number }>;
    /** price impact for 0.1%/1%/5%-of-depth trades from latest reserves */
    price_impact: Metric<Array<{ size_fraction: number; impact_pct: number }>>;
  };
  explanation: string;
}

const DAY_S = 86_400;

export async function buildRiskReport(
  store: DexStore,
  pool: PoolRow,
  nowTs: number = Math.floor(Date.now() / 1000)
): Promise<RiskReport> {
  const latest = await store.latestReserve(pool.id);
  const net = await store.netLiquidity(pool.id);
  const removed24h = await store.sumEvents(pool.id, "remove", nowTs - DAY_S);
  const swaps24h = await store.sumEvents(pool.id, "swap", nowTs - DAY_S);
  const activity = await store.poolActivity(pool.id);

  const depth: RiskReport["metrics"]["depth"] =
    latest && latest.reserve0 !== null && latest.reserve1 !== null
      ? {
          value: { reserve0: latest.reserve0, reserve1: latest.reserve1 },
          inputs: { block_number: latest.blockNumber.toString() },
          source: "pool_reserves (Sync events)",
        }
      : { value: null, inputs: {}, source: "pool_reserves (no Sync observed for this pool)" };

  const netTotal = net.amount0 + net.amount1;
  const removedTotal = removed24h.amount0 + removed24h.amount1;
  const withdrawalPct = netTotal > 0n ? (Number(removedTotal) / Number(netTotal + removedTotal)) * 100 : null;
  const withdrawal: RiskReport["metrics"]["withdrawal_24h_pct"] = {
    value: withdrawalPct,
    inputs: {
      removed_24h_amount0: removed24h.amount0.toString(),
      removed_24h_amount1: removed24h.amount1.toString(),
      net_amount0: net.amount0.toString(),
      net_amount1: net.amount1.toString(),
      window_seconds: DAY_S,
    },
    source: "liquidity_events (last 24h removes vs all-time net)",
  };

  const reserve0 = latest?.reserve0 ? BigInt(latest.reserve0) : null;
  const volRatio =
    reserve0 && reserve0 > 0n ? Number(swaps24h.amount0) / Number(reserve0) : null;
  const volumeLiquidity: RiskReport["metrics"]["volume_liquidity_ratio"] = {
    value: volRatio,
    inputs: {
      swap_amount0_24h: swaps24h.amount0.toString(),
      reserve0: latest?.reserve0 ?? null,
      window_seconds: DAY_S,
    },
    source: "liquidity_events swaps + latest pool_reserves (token0 units)",
  };

  const age: RiskReport["metrics"]["age_and_activity"] = {
    value: {
      age_blocks:
        pool.createdBlock !== null && activity.lastBlock !== null
          ? (activity.lastBlock - pool.createdBlock).toString()
          : null,
      observed_events: activity.events,
    },
    inputs: {
      created_block: pool.createdBlock?.toString() ?? null,
      last_event_block: activity.lastBlock?.toString() ?? null,
    },
    source: "pools.created_block + liquidity_events",
  };

  const impacts =
    latest && latest.reserve0 !== null && latest.reserve1 !== null
      ? estimateImpact(BigInt(latest.reserve0), BigInt(latest.reserve1)).map((i) => ({
          size_fraction: i.sizeFraction,
          impact_pct: i.impactPct,
        }))
      : null;
  const priceImpact: RiskReport["metrics"]["price_impact"] = {
    value: impacts,
    inputs: { sizes: "0.1%, 1%, 5% of reserve0", fee_bps: 30 },
    source: "constant-product math on latest pool_reserves",
  };

  const m: RiskReport["metrics"] = {
    depth,
    lp_concentration: { value: null, inputs: {}, source: "LP token holder data not collected by this engine" },
    withdrawal_24h_pct: withdrawal,
    volume_liquidity_ratio: volumeLiquidity,
    holder_concentration: { value: null, inputs: {}, source: "pool-token holder data not collected by this engine" },
    age_and_activity: age,
    price_impact: priceImpact,
  };

  const parts: string[] = [];
  parts.push(
    depth.value
      ? `reserves ${depth.value.reserve0} / ${depth.value.reserve1} token units`
      : "reserves unknown (no Sync observed)"
  );
  parts.push(
    withdrawal.value !== null
      ? `24h withdrawals = ${withdrawal.value.toFixed(2)}% of net liquidity`
      : "no liquidity history for withdrawal metric"
  );
  if (volRatio !== null) parts.push(`24h volume/liquidity ratio = ${volRatio.toFixed(4)}`);
  if (impacts)
    parts.push(
      "price impact " + impacts.map((i) => `${(i.size_fraction * 100).toFixed(1)}%-of-depth trade -> ${i.impact_pct.toFixed(2)}%`).join(", ")
    );
  parts.push(`age ${age.value?.age_blocks ?? "?"} blocks, ${age.value?.observed_events ?? 0} observed events`);
  const explanation = `Pool ${pool.id} on ${pool.dex}: ${parts.join("; ")}. Metrics are token-unit based (no USD source configured); LP/holder concentration unavailable (not collected).`;

  return { pool_id: pool.id, chain_id: pool.chainId, dex: pool.dex, metrics: m, explanation };
}
