// Lazy pool discovery: RPC probe registers known-factory pools, negative-
// caches foreign/non-contract addresses.

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { encodeFunctionData, encodeFunctionResult, parseAbiItem, type AbiFunction } from "viem";
import { LazyPoolDiscovery, type RpcCaller } from "../src/discovery.js";
import { DexProcessor, buildFactoryMap, loadDexes, type FactoryMap } from "../src/processor.js";
import { PoolRegistry } from "../src/pools.js";
import { FakeAlertSink, FakeDexStore, loadRawLogs, toNormalizedEvent } from "./helpers.js";
import { poolId } from "../src/store.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const raw = loadRawLogs();
const USDT_WETH_PAIR = "0x0d4a11d5eeaac28ec3f61d100daf4d40471f1852";
const V2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";

const F = (s: string) => parseAbiItem(s) as AbiFunction;
const FACTORY = F("function factory() view returns (address)");
const TOKEN0 = F("function token0() view returns (address)");
const TOKEN1 = F("function token1() view returns (address)");
const sel = (fn: AbiFunction) => encodeFunctionData({ abi: [fn], functionName: fn.name });

const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

const factories = new Map<number, FactoryMap>([
  [1, new Map([[V2_FACTORY, { name: "uniswap_v2", type: "v2" as const }]])],
]);

function fakeCaller(handlers: Record<string, Record<string, unknown>>, counter = { n: 0 }): RpcCaller {
  return async (_c, to, data) => {
    counter.n++;
    const table = handlers[to.toLowerCase()];
    if (!table) return "0x";
    for (const [fn, ret] of [
      [FACTORY, table.factory], [TOKEN0, table.token0], [TOKEN1, table.token1],
    ] as const) {
      if (data === sel(fn)) {
        if (ret === undefined) return "0x";
        return encodeFunctionResult({ abi: [fn], functionName: fn.name, result: ret as never });
      }
    }
    return "0x";
  };
}

describe("lazy pool discovery", () => {
  it("probes factory()/token0()/token1() and reports a known-factory pool", async () => {
    const counter = { n: 0 };
    const call = fakeCaller({
      [USDT_WETH_PAIR]: { factory: V2_FACTORY, token0: USDT, token1: WETH },
    }, counter);
    const d = new LazyPoolDiscovery(call, factories, 100, { maxAttempts: 1, baseMs: 1, capMs: 1 });
    const found = await d.discover(1, USDT_WETH_PAIR);
    expect(found).toMatchObject({
      dex: "uniswap_v2", dexType: "v2", token0: USDT, token1: WETH, discovery: "lazy",
    });
    expect(counter.n).toBe(3); // factory + token0 + token1
  });

  it("foreign-factory address is negative-cached and queried once", async () => {
    const counter = { n: 0 };
    const call = fakeCaller({
      [USDT_WETH_PAIR]: { factory: "0x000000000000000000000000000000000000dead" },
    }, counter);
    const d = new LazyPoolDiscovery(call, factories, 100, { maxAttempts: 1, baseMs: 1, capMs: 1 });
    expect(await d.discover(1, USDT_WETH_PAIR)).toBeNull();
    expect(await d.discover(1, USDT_WETH_PAIR)).toBeNull();
    expect(counter.n).toBe(1); // one factory() call, then cached
  });

  it("end-to-end: a Sync from an unregistered known-factory pool registers it lazily", async () => {
    const store = new FakeDexStore();
    const counter = { n: 0 };
    const call = fakeCaller({
      [USDT_WETH_PAIR]: { factory: V2_FACTORY, token0: USDT, token1: WETH },
    }, counter);
    const discovery = new LazyPoolDiscovery(call, factories, 100, { maxAttempts: 1, baseMs: 1, capMs: 1 });
    const p = new DexProcessor({
      store,
      registry: new PoolRegistry(store),
      factories: buildFactoryMap(loadDexes(), 1),
      sink: new FakeAlertSink(),
      removalThresholdPct: 20,
      log,
      discovery,
    });
    await p.handleEvent(toNormalizedEvent(raw.v2_sync, 1));
    const row = store.pools.get(poolId(1, USDT_WETH_PAIR));
    expect(row).toBeTruthy();
    expect(row!.dex).toBe("uniswap_v2");
    expect(row!.discovery).toBe("lazy");
    expect(store.reserves.some((r) => r.poolId === poolId(1, USDT_WETH_PAIR))).toBe(true);
  });
});

describe("pinned pool seeding", () => {
  it("registers a pinned pool via the lazy probe path with discovery 'pinned'", async () => {
    const call = fakeCaller({
      [USDT_WETH_PAIR]: { factory: V2_FACTORY, token0: USDT, token1: WETH },
    });
    const discovery = new LazyPoolDiscovery(call, factories, 100, { maxAttempts: 1, baseMs: 1, capMs: 1 });
    const store = new FakeDexStore();
    const registry = new PoolRegistry(store);
    const info = await discovery.discover(1, USDT_WETH_PAIR);
    expect(info).not.toBeNull();
    const row = await registry.registerLazy(USDT_WETH_PAIR, info!,
      { chain_id: 1, block_number: null, tx_hash: null, block_hash: null } as never, "pinned");
    expect(row.discovery).toBe("pinned");
    expect(store.pools.get(`1:${USDT_WETH_PAIR}`)?.discovery).toBe("pinned");
  });
});
