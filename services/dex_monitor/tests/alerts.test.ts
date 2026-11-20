import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { maybeAlertRemoval } from "../src/alerts.js";
import { FakeAlertSink, FakeDexStore, syntheticLogEvent } from "./helpers.js";
import { poolId } from "../src/store.js";
import type { PoolRow } from "../src/store.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const PAIR = "0x" + "aa".repeat(20);
const PID = poolId(1, PAIR);
const TX = "0x" + "9".repeat(64);
const BURN_TOPIC0 = "0xdccd412f0b1252819cb1fd330b93224ca42612892bb3f4f789976e6d81936496";

const pool: PoolRow = {
  id: PID,
  dex: "uniswap_v2",
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "b2".repeat(20),
  chainId: 1,
  feeTier: null,
  createdBlock: 100n,
  createdTx: "0x" + "1".repeat(64),
};

function burnEvent(): ReturnType<typeof syntheticLogEvent> {
  return syntheticLogEvent({
    chainId: 1,
    contract: PAIR,
    topics: [BURN_TOPIC0, "0x" + "0".repeat(24) + "ee".repeat(20)],
    data: "0x",
    block: 300,
    txHash: TX,
  });
}

function seededStore(net0: bigint, net1: bigint): FakeDexStore {
  const store = new FakeDexStore();
  store.pools.set(PID, pool);
  store.liquidityEvents.push({
    poolId: PID,
    chainId: 1,
    eventType: "add",
    amount0: net0.toString(),
    amount1: net1.toString(),
    txHash: "0x" + "8".repeat(64),
    blockNumber: 100n,
  });
  store.txSenders.set(`1:${TX}`, "0x" + "dd".repeat(20));
  return store;
}

function input(store: FakeDexStore, sink: FakeAlertSink, removed: bigint, net: bigint) {
  return {
    ev: burnEvent(),
    pool,
    poolAddress: PAIR,
    sender: "0x" + "ee".repeat(20),
    removed0: removed,
    removed1: removed,
    net0Before: net,
    net1Before: net,
    thresholdPct: 20,
    sink,
    store,
    log,
  };
}

describe("liquidity-removal alerts", () => {
  it("removal at exactly the threshold alerts with all BLUEPRINT §6 fields", async () => {
    const store = seededStore(1000n, 1000n);
    const sink = new FakeAlertSink();
    const rec = await maybeAlertRemoval(input(store, sink, 200n, 1000n)); // 20.00%
    expect(rec).not.toBeNull();
    const f = rec!.facts;
    expect(f.pool_id).toBe(PID);
    expect(f.dex).toBe("uniswap_v2");
    expect(f.wallet).toBe("0x" + "dd".repeat(20));
    expect(f.wallet_source).toContain("transactions.sender");
    expect(f.tx_hash).toBe(TX);
    expect(f.block_number).toBe(300);
    expect(f.removed_amount0).toBe("200");
    expect(f.removal_pct).toBeCloseTo(20, 5);
    expect(f.valuation_source).toContain("token units");
    expect(f.estimated_value).toContain("token0");
    expect(f.remaining_amount0).toBe("800");
    expect(f.prior_similar_actions).toBe(0);
    expect(rec!.source_engine).toBe("dex_monitor");
    expect(rec!.dedup_key).toBe(burnEvent().dedup_key);
  });

  it("just below the threshold does not alert", async () => {
    const store = seededStore(1000n, 1000n);
    const sink = new FakeAlertSink();
    const rec = await maybeAlertRemoval(input(store, sink, 199n, 1000n)); // 19.9%
    expect(rec).toBeNull();
    expect(sink.records).toHaveLength(0);
  });

  it("replaying the same removal produces exactly one alert", async () => {
    const store = seededStore(1000n, 1000n);
    const sink = new FakeAlertSink();
    await maybeAlertRemoval(input(store, sink, 200n, 1000n));
    // pretend the alerts-table row exists (store.insertAlert writes it via sink in prod;
    // FakeAlertSink bypasses store — simulate by inserting the message row)
    const rec = sink.records[0];
    await store.insertAlert({ dedupKey: rec.dedup_key, sourceEngine: rec.source_engine,
      kind: rec.kind, chainId: rec.chain_id, destination: "nexus:alerts", message: JSON.stringify(rec) });
    const again = await maybeAlertRemoval(input(store, sink, 200n, 1000n));
    expect(again).toBeNull();
    expect(sink.records).toHaveLength(1);
    expect(store.alerts).toHaveLength(1);
  });
});
