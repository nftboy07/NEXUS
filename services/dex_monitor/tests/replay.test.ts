// End-to-end replay: fixture log sequence through DexProcessor ->
// expected pools / liquidity_events / pool_reserves rows.

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { DexProcessor, buildFactoryMap, loadDexes } from "../src/processor.js";
import { PoolRegistry } from "../src/pools.js";
import { FakeAlertSink, FakeDexStore, loadRawLogs, toNormalizedEvent } from "./helpers.js";
import { poolId } from "../src/store.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const raw = loadRawLogs();
const USDT_WETH_PAIR = "0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852";

function makeProcessor(store: FakeDexStore, sink: FakeAlertSink) {
  return new DexProcessor({
    store,
    registry: new PoolRegistry(store),
    factories: buildFactoryMap(loadDexes(), 1),
    sink,
    removalThresholdPct: 20,
    log,
  });
}

describe("end-to-end replay", () => {
  it("pair_created -> pools row; mint/burn/swap/sync -> liquidity + reserve rows", async () => {
    const store = new FakeDexStore();
    const sink = new FakeAlertSink();
    const p = makeProcessor(store, sink);

    // Replay the real recorded sequence.
    await p.handleEvent(toNormalizedEvent(raw.v2_pair_created, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_mint, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_sync, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_swap, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_burn, 1));

    // pools: the pair from PairCreated is registered.
    const pairRow = [...store.pools.values()].find((r) => r.dex === "uniswap_v2");
    expect(pairRow).toBeTruthy();
    expect(pairRow!.token0).toBe("0x88f6c36028b40aac445bebc080667b534d225ff3");
    expect(pairRow!.token1).toBe("0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2");
    expect(pairRow!.chainId).toBe(1);

    // The USDT/WETH pair's own events were processed only if it is a known
    // pool — it is not (created long before our fixtures), so nothing for it.
    const pairEvents = store.liquidityEvents.filter((e) => e.poolId === poolId(1, USDT_WETH_PAIR));
    expect(pairEvents).toHaveLength(0);
  });

  it("registered pool: mint/sync/burn/swap land in the right tables", async () => {
    const store = new FakeDexStore();
    const sink = new FakeAlertSink();
    const p = makeProcessor(store, sink);

    // Pre-register the USDT/WETH pair (as if its PoolCreated was seen).
    const registry = new PoolRegistry(store);
    await registry.register(
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
        tx_hash: "0xseed",
        payload: {},
      }
    );

    await p.handleEvent(toNormalizedEvent(raw.v2_mint, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_sync, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_swap, 1));
    await p.handleEvent(toNormalizedEvent(raw.v2_burn, 1));

    const pid = poolId(1, USDT_WETH_PAIR);
    const types = store.liquidityEvents.filter((e) => e.poolId === pid).map((e) => e.eventType);
    expect(types).toEqual(["add", "swap", "remove"]);
    const res = store.reserves.filter((r) => r.poolId === pid);
    expect(res).toHaveLength(1);
    expect(res[0].source).toBe("sync");
    expect(res[0].reserve0).toBe(String(BigInt("0xbe05bec346b0dd06b9")));
  });

  it("replay is idempotent: reprocessing the same events changes nothing", async () => {
    const store = new FakeDexStore();
    const sink = new FakeAlertSink();
    const p = makeProcessor(store, sink);
    const registry = new PoolRegistry(store);
    // note: p has its own registry; register via p's path with a real event
    await p.handleEvent(toNormalizedEvent(raw.v2_pair_created, 1));
    // second delivery of the same event
    await p.handleEvent(toNormalizedEvent(raw.v2_pair_created, 1));
    expect(store.pools.size).toBe(1);
    void registry;
  });
});
