import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { runChains } from "../src/runner.js";
import type { ParsedLogFilter } from "../src/subscriptions.js";
import { FakePublisher, FakeStore, FakeSource } from "./helpers.js";
import type { ChainSource } from "../src/rpc.js";
import type { ChainConfig } from "../src/config.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const filters: ParsedLogFilter[] = [
  { name: "erc20_transfer", abiEvent: {} as never, topics: [["0xtransfer"]] },
];

function fakeChain(id: number, name: string): ChainConfig {
  return { id, name, confirmations: 12, wssEnv: "X", httpEnv: "Y", wssUrl: "ws://x", httpUrl: "http://x" };
}

function fakeClients(source: ChainSource, failSubscribe = false) {
  const ws = {
    watchBlocks: () => {
      if (failSubscribe) throw new Error("ws subscribe failed");
      return () => {};
    },
    watchEvent: () => {
      if (failSubscribe) throw new Error("ws subscribe failed");
      return () => {};
    },
  };
  // ChainRunner uses viemChainSource(http) — inject the fake by monkey-patching
  // is not needed: runChains only calls source() which wraps clients.http.
  // For the isolation test we only need start() to succeed/fail, so provide an
  // http client exposing the minimal surface via a cast.
  const http = {
    getBlockNumber: () => source.getBlockNumber(),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => {
      return source.getBlock(blockNumber);
    },
    getLogs: ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) =>
      source.getLogs({ topics: [], fromBlock, toBlock }),
  };
  const clients = { role: "primary" as const, ws: ws as never, http: http as never };
  return { primary: clients };
}

const chainB_blocks = [
  { number: 100n, hash: "0x" + "a".repeat(64), parentHash: "0x" + "0".repeat(64), timestamp: 1n },
];

describe("per-chain isolation", () => {
  it("one chain failing at start does not stop the other", async () => {
    const goodSource = FakeSource.fromFixture(chainB_blocks, [], 100n);
    const failingSource: ChainSource = {
      getBlockNumber: () => Promise.reject(new Error("endpoint dead")),
      getBlock: () => Promise.reject(new Error("endpoint dead")),
      getLogs: () => Promise.reject(new Error("endpoint dead")),
    };
    const store = new FakeStore();
    await store.setCheckpoint(8453, 99n, null);
    const errors: Array<{ chain: string; err: unknown }> = [];

    const runners = await runChains(
      [
        { chain: fakeChain(1, "ethereum"), filters, store, publisher: new FakePublisher(), log, clients: fakeClients(failingSource) },
        { chain: fakeChain(8453, "base"), filters, store, publisher: new FakePublisher(), log, clients: fakeClients(goodSource) },
      ],
      (chain, err) => errors.push({ chain: chain.name, err })
    );

    expect(runners).toHaveLength(1);
    expect(runners[0].deps.chain.name).toBe("base");
    expect(errors).toHaveLength(1);
    expect(errors[0].chain).toBe("ethereum");
    // the surviving chain actually ingested
    expect((await store.getCheckpoint(8453))?.lastBlock).toBe(100n);
    await Promise.all(runners.map((r) => r.stop()));
  });
});
