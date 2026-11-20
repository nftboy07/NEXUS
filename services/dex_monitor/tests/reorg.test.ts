// Reorg propagation: a block_removed event must invalidate every Engine 4
// row derived from the orphaned block (pools, liquidity_events, reserves).

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import { DexProcessor, buildFactoryMap, loadDexes } from "../src/processor.js";
import { PoolRegistry } from "../src/pools.js";
import { FakeAlertSink, FakeDexStore, loadRawLogs, toNormalizedEvent } from "./helpers.js";
import { poolId } from "../src/store.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const raw = loadRawLogs();
const USDT_WETH_PAIR = "0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852";
const SEED_HASH = "0xseedblock000000000000000000000000000000000000000000000000000000";

function makeProcessor(store: FakeDexStore) {
  return new DexProcessor({
    store,
    registry: new PoolRegistry(store),
    factories: buildFactoryMap(loadDexes(), 1),
    sink: new FakeAlertSink(),
    removalThresholdPct: 20,
    log,
  });
}

const removed = (blockHash: string): NexusNormalizedEvent => ({
  chain_id: 1,
  kind: "block_removed",
  dedup_key: `1:${blockHash}:removed`,
  block_number: null,
  block_hash: blockHash,
  tx_hash: null,
  payload: { block_hash: blockHash, block_number: null },
});

describe("block_removed invalidation", () => {
  it("deletes liquidity_events, reserves and pools from the orphaned block", async () => {
    const store = new FakeDexStore();
    const p = makeProcessor(store);
    // Pre-register the pair; its pools row carries the seed block hash.
    await new PoolRegistry(store).register(
      {
        kind: "PoolCreated",
        dex: "uniswap_v2",
        dexType: "v2",
        token0: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        token1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        pool: USDT_WETH_PAIR,
        feeTier: null,
      },
      {
        chain_id: 1,
        kind: "log",
        dedup_key: "1:0xseed:0xseed:0",
        block_number: 10000000,
        block_hash: SEED_HASH,
        tx_hash: "0xseed",
        payload: {},
      }
    );
    const mint = toNormalizedEvent(raw.v2_mint, 1);
    const sync = toNormalizedEvent(raw.v2_sync, 1);
    await p.handleEvent(mint);
    await p.handleEvent(sync);
    const pid = poolId(1, USDT_WETH_PAIR);
    expect(store.liquidityEvents.filter((e) => e.poolId === pid).length).toBeGreaterThan(0);
    expect(store.reserves.filter((r) => r.poolId === pid).length).toBeGreaterThan(0);
    expect(store.pools.size).toBe(1);

    // Orphan the mint/sync block: its rows go; the pool (different block) stays.
    await p.handleEvent(removed(mint.block_hash!));
    expect(store.liquidityEvents.filter((e) => e.blockHash === mint.block_hash)).toHaveLength(0);
    expect(store.reserves.filter((r) => r.blockHash === mint.block_hash)).toHaveLength(0);
    expect(store.pools.size).toBe(1);

    // Orphan the registration block: the pool row goes too.
    await p.handleEvent(removed(SEED_HASH));
    expect(store.pools.size).toBe(0);
  });

  it("ignores unrelated kinds and reorg payloads without block_hash", async () => {
    const store = new FakeDexStore();
    const p = makeProcessor(store);
    await p.handleEvent({ ...removed("0xdead"), payload: {} });
    await p.handleEvent(removed("0xdead"));
    expect(store.pools.size).toBe(0);
  });
});
