import { describe, expect, it } from "vitest";
import { buildRiskReport } from "../src/risk.js";
import { FakeDexStore } from "./helpers.js";
import { poolId } from "../src/store.js";
import type { PoolRow } from "../src/store.js";

const PAIR = "0x" + "aa".repeat(20);
const PID = poolId(1, PAIR);

const pool: PoolRow = {
  id: PID,
  dex: "uniswap_v2",
  token0: "0x" + "t0".repeat(20),
  token1: "0x" + "t1".repeat(20),
  chainId: 1,
  feeTier: null,
  createdBlock: 100n,
  createdTx: "0x" + "1".repeat(64),
};

function seed(): FakeDexStore {
  const store = new FakeDexStore();
  store.pools.set(PID, pool);
  // add 1000/1000 then remove 600/600 -> 60% withdrawal
  store.liquidityEvents.push(
    { poolId: PID, chainId: 1, eventType: "add", amount0: "1000", amount1: "1000", txHash: "0x" + "a".repeat(64), blockNumber: 200n },
    { poolId: PID, chainId: 1, eventType: "remove", amount0: "600", amount1: "600", txHash: "0x" + "b".repeat(64), blockNumber: 210n },
    { poolId: PID, chainId: 1, eventType: "swap", amount0: "50", amount1: "0", txHash: "0x" + "c".repeat(64), blockNumber: 205n }
  );
  store.reserves.push({
    poolId: PID,
    chainId: 1,
    reserve0: "400",
    reserve1: "400",
    source: "sync",
    blockNumber: 210n,
  });
  return store;
}

describe("Liquidity Risk Radar", () => {
  it("60% single-day removal -> withdrawal ~60%, explanation cites it, no verdict", async () => {
    const report = await buildRiskReport(seed(), pool, 1_700_000_000);
    expect(report.metrics.withdrawal_24h_pct.value).toBeCloseTo(60, 1);
    expect(report.explanation).toContain("60.00%");
    expect(report.explanation.toLowerCase()).not.toMatch(/\bsafe\b|\bunsafe\b|\brug\b/);
  });

  it("depth + volume metrics carry values and sources", async () => {
    const report = await buildRiskReport(seed(), pool, 1_700_000_000);
    expect(report.metrics.depth.value).toEqual({ reserve0: "400", reserve1: "400" });
    expect(report.metrics.depth.source).toContain("pool_reserves");
    // 50 swap amount0 / 400 reserve0
    expect(report.metrics.volume_liquidity_ratio.value).toBeCloseTo(0.125, 4);
    expect(report.metrics.lp_concentration.value).toBeNull();
    expect(report.metrics.lp_concentration.source).toContain("not collected");
    expect(report.metrics.age_and_activity.value?.age_blocks).toBe("110");
    expect(report.metrics.price_impact.value?.length).toBe(3);
  });

  it("missing reserves -> depth null with named source, not a guess", async () => {
    const store = seed();
    store.reserves = [];
    const report = await buildRiskReport(store, pool, 1_700_000_000);
    expect(report.metrics.depth.value).toBeNull();
    expect(report.metrics.depth.source).toContain("no Sync observed");
    expect(report.metrics.volume_liquidity_ratio.value).toBeNull();
  });
});
