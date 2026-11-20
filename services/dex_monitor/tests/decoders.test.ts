import { describe, expect, it } from "vitest";
import { decodeLogEvent, type DecodeContext } from "../src/decoders.js";
import { buildFactoryMap, loadDexes } from "../src/processor.js";
import { loadRawLogs, toNormalizedEvent } from "./helpers.js";

const raw = loadRawLogs();
const dexes = loadDexes();
const allFactories = new Map(
  dexes.map((d) => [d.factory.toLowerCase(), { name: d.name, type: d.type }])
);
const asPool: DecodeContext = { factories: allFactories, isPool: () => true };
const notPool: DecodeContext = { factories: allFactories, isPool: () => false };

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";

describe("factory events (real recorded logs)", () => {
  it("decodes a real Uniswap V2 PairCreated", () => {
    const ev = toNormalizedEvent(raw.v2_pair_created, 1);
    const d = decodeLogEvent(ev, notPool);
    expect(d).toMatchObject({
      kind: "PoolCreated",
      dex: "uniswap_v2",
      dexType: "v2",
      token0: "0x88f6c36028b40aac445bebc080667b534d225ff3",
      token1: WETH,
      pool: "0x4da26fba319fcaeb029932ba41322f21d221ba73",
      feeTier: null,
    });
  });

  it("decodes a real Uniswap V3 PoolCreated (Ethereum)", () => {
    const ev = toNormalizedEvent(raw.v3_pool_created, 1);
    const d = decodeLogEvent(ev, notPool);
    expect(d).toMatchObject({
      kind: "PoolCreated",
      dex: "uniswap_v3",
      dexType: "v3",
      token0: WETH,
      token1: "0xc9d508d259e946ad3fe76a04504fdef2dc056301",
      pool: "0x79dccfe8a6c78cece4ce4b1ee4b24662d1ce61b8",
      feeTier: 100,
    });
  });

  it("decodes a real Uniswap V3 PoolCreated (Base)", () => {
    const ev = toNormalizedEvent(raw.base_v3_pool_created, 8453);
    const d = decodeLogEvent(ev, notPool);
    expect(d).toMatchObject({
      kind: "PoolCreated",
      dex: "uniswap_v3",
      dexType: "v3",
      pool: "0x19377fb7bbffb4674ceff87df1ec2cc8fd4f6f54",
      feeTier: 3000,
    });
  });
});

describe("pool events (real recorded logs, USDT/WETH UniV2 pair)", () => {
  it("decodes a real Mint", () => {
    const d = decodeLogEvent(toNormalizedEvent(raw.v2_mint, 1), asPool);
    expect(d).toMatchObject({
      kind: "LiquidityAdded",
      sender: "0x396a940e37c486c5c3e612d49be89b762ea1b1a5",
      amount0: BigInt("0x9184e72a000"),
      amount1: BigInt("0x43a8"),
      v3: false,
    });
  });

  it("decodes a real Burn (removal)", () => {
    const d = decodeLogEvent(toNormalizedEvent(raw.v2_burn, 1), asPool);
    expect(d).toMatchObject({
      kind: "LiquidityRemoved",
      sender: "0x396a940e37c486c5c3e612d49be89b762ea1b1a5",
      amount0: 88338100418919920n,
      amount1: 153462008n,
      v3: false,
    });
  });

  it("decodes a real Swap + Sync", () => {
    const swap = decodeLogEvent(toNormalizedEvent(raw.v2_swap, 1), asPool);
    expect(swap).toMatchObject({ kind: "Swap", v3: false, amount0In: 1042515201012921216n, amount1Out: 1817699361n });
    const sync = decodeLogEvent(toNormalizedEvent(raw.v2_sync, 1), asPool);
    expect(sync).toMatchObject({
      kind: "ReserveUpdate",
      reserve0: BigInt("0xbe05bec346b0dd06b9"),
      reserve1: BigInt("0x592dbce2816"),
    });
  });
});

describe("negative cases", () => {
  it("ignores pool events from unregistered contracts", () => {
    const d = decodeLogEvent(toNormalizedEvent(raw.v2_mint, 1), notPool);
    expect(d).toBeNull();
  });

  it("ignores factory events from non-factory addresses", () => {
    const ev = toNormalizedEvent(raw.v2_pair_created, 1);
    (ev.payload as { contract: string }).contract = "0x" + "f".repeat(40);
    expect(decodeLogEvent(ev, notPool)).toBeNull();
  });

  it("ignores removed logs", () => {
    const ev = toNormalizedEvent(raw.v2_mint, 1);
    (ev.payload as { removed: boolean }).removed = true;
    expect(decodeLogEvent(ev, asPool)).toBeNull();
  });
});
