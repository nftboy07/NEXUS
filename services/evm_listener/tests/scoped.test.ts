// Scoped log filters (LOG_FILTER_MODE=scoped): allowlisted-token transfers,
// watchlist-wallet topic filters, DEX events scoped to known addresses,
// chunking, refresh resubscribe + backfill.

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { buildScopedFilters, filterFingerprint } from "../src/scopedFilters.js";
import { runChains, type RunnerDeps } from "../src/runner.js";
import type { ParsedLogFilter } from "../src/subscriptions.js";
import type { ChainConfig } from "../src/config.js";
import { fakeClients, FakePublisher, FakeSource, FakeStore, makeBlocks } from "./helpers.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const A = (c: string) => "0x" + c.repeat(40);
const W = (c: string) => "0x" + c.repeat(40);

const BASE: ParsedLogFilter[] = [
  { name: "erc20_transfer", abiEvent: {} as never, topics: [["0xddf252ad"]] },
  { name: "dex_v2_sync", abiEvent: {} as never, topics: [["0xsync"]] },
  { name: "univ2_factory_pair_created", abiEvent: {} as never, address: "0xfactory", topics: [["0xpc"]] },
];

const TOKENS = [
  { chain_id: 1, symbol: "USDC", address: A("a"), decimals: 6, source: "t" },
  { chain_id: 1, symbol: "WETH", address: A("b"), decimals: 18, source: "t" },
];
const DEXES = [
  { chain_id: 1, name: "uniswap_v2", factory: A("f"),
    pinned_pools: [{ address: A("d"), pair: "WETH/USDC", derivation: "getPair" }] },
];

describe("buildScopedFilters", () => {
  it("scopes transfers to allowlisted tokens, watch topics, and known addresses", () => {
    const out = buildScopedFilters(BASE, {
      chainId: 1, tokens: TOKENS, watchWallets: [W("e")],
      pools: [A("9")], dexes: DEXES, maxAddresses: 100,
    });
    const names = out.map((f) => f.name);
    // token-scoped transfer
    const tok = out.find((f) => f.name === "erc20_transfer:tokens:0");
    expect(tok!.address).toEqual([A("a"), A("b")]);
    // wallet topic1 + topic2 filters
    const from = out.find((f) => f.name === "erc20_transfer:watch_from:0")!;
    const to = out.find((f) => f.name === "erc20_transfer:watch_to:0")!;
    const padded = "0x" + "0".repeat(24) + "e".repeat(40);
    expect(from.topics).toEqual([["0xddf252ad"], [padded]]);
    expect(to.topics).toEqual([["0xddf252ad"], null, [padded]]);
    expect(from.args).toEqual({ from: [W("e")] });
    // dex scoped to factory + pinned + pools-table
    const sync = out.find((f) => f.name === "dex_v2_sync:0")!;
    expect(sync.address).toEqual([A("f"), A("d"), A("9")]);
    // factory creation filter untouched
    expect(out.find((f) => f.name === "univ2_factory_pair_created")!.address).toBe("0xfactory");
  });

  it("chunks address arrays at maxAddresses", () => {
    const manyTokens = Array.from({ length: 101 }, (_, i) => ({
      chain_id: 1, symbol: `T${i}`, address: `0x${String(i).padStart(40, "0")}`, decimals: 18, source: "t",
    }));
    const out = buildScopedFilters(BASE, {
      chainId: 1, tokens: manyTokens, watchWallets: [],
      pools: [], dexes: DEXES, maxAddresses: 100,
    });
    const chunks = out.filter((f) => f.name.startsWith("erc20_transfer:tokens:"));
    expect(chunks).toHaveLength(2);
    expect((chunks[0].address as string[]).length).toBe(100);
    expect((chunks[1].address as string[]).length).toBe(1);
  });

  it("produces no wallet filters when the watchlist is empty", () => {
    const out = buildScopedFilters(BASE, {
      chainId: 1, tokens: TOKENS, watchWallets: [], pools: [], dexes: DEXES, maxAddresses: 100,
    });
    expect(out.some((f) => f.name.includes("watch_"))).toBe(false);
  });
});

describe("filter refresh", () => {
  function fakeChain(id: number): ChainConfig {
    return { id, name: "ethereum", confirmations: 12, wssEnv: "X", httpEnv: "Y", wssUrl: "ws://x", httpUrl: "http://x" };
  }

  it("resubscribes and backfills from checkpoint when filters change", async () => {
    const store = new FakeStore();
    await store.setCheckpoint(1, 90n, null);
    const source = FakeSource.fromFixture(makeBlocks(1n, 100n), []);
    const { primary, captured } = fakeClients(source);
    let wallets: string[] = [];
    const deps: RunnerDeps = {
      chain: fakeChain(1),
      filters: BASE,
      store,
      publisher: new FakePublisher(),
      log,
      clients: { primary },
      startBackfillBlocks: 0,
      chunkSize: 2000,
      filterRefresh: {
        intervalSeconds: 1,
        build: async () => buildScopedFilters(BASE, {
          chainId: 1, tokens: TOKENS, watchWallets: wallets,
          pools: [], dexes: DEXES, maxAddresses: 100,
        }),
      },
    };
    const [runner] = await runChains([deps]);
    const before = captured.watchEvents ?? 0;
    expect(before).toBeGreaterThan(0);
    const filtersBefore = filterFingerprint(BASE);

    // New watchlist wallet -> fingerprint changes -> resubscribe
    wallets = [W("e")];
    await new Promise((r) => setTimeout(r, 1300));
    await runner.drain();
    expect(captured.watchEvents).toBeGreaterThan(before);
    await runner.stop();
    expect(filterFingerprint(BASE)).toBe(filtersBefore); // full-mode static set untouched
  }, 15000);
});
