// Pipeline-level tests: cold start, head gaps, per-filter log fetch,
// provider range limits, transactions table population.

import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { fetchFilterLogs, fetchLogs } from "../src/backfill.js";
import { ingestTransactions } from "../src/ingest.js";
import { runChains, type RunnerDeps } from "../src/runner.js";
import type { ParsedLogFilter } from "../src/subscriptions.js";
import type { ChainConfig } from "../src/config.js";
import {
  fakeClients,
  FakePublisher,
  FakeSource,
  FakeStore,
  makeBlocks,
  RangeLimitSource,
} from "./helpers.js";
import type { SourceLog } from "../src/rpc.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const FILTER_A: ParsedLogFilter = { name: "transfer_all", abiEvent: {} as never, topics: [["0xtopicA"]] };
const ADDR_B = "0x" + "b".repeat(40);
const FILTER_B: ParsedLogFilter = { name: "token_scoped", abiEvent: {} as never, address: ADDR_B, topics: [["0xtopicB"]] };

function fakeChain(id: number, name: string, startBlock?: bigint): ChainConfig {
  return { id, name, confirmations: 12, wssEnv: "X", httpEnv: "Y", wssUrl: "ws://x", httpUrl: "http://x", startBlock };
}

function runnerDeps(source: FakeSource, chain: ChainConfig, store: FakeStore): { deps: RunnerDeps; captured: ReturnType<typeof fakeClients>["captured"] } {
  const { primary, captured } = fakeClients(source);
  return {
    captured,
    deps: {
      chain,
      filters: [FILTER_A],
      store,
      publisher: new FakePublisher(),
      log,
      clients: { primary },
      startBackfillBlocks: 50,
      chunkSize: 2000,
    },
  };
}

function mkLog(block: { number: bigint; hash: string }, i: number, txHash: string, address = "0x" + "1".repeat(40)): SourceLog {
  return {
    address,
    blockHash: block.hash,
    blockNumber: block.number,
    transactionHash: txHash,
    logIndex: i,
    data: "0x" + "0".repeat(64),
    topics: ["0xtopicA"],
    transactionIndex: 0,
    removed: false,
  };
}

describe("cold start", () => {
  it("no checkpoint + head=1000 -> only (950,1000] fetched", async () => {
    const blocks = makeBlocks(951n, 1000n);
    const source = FakeSource.fromFixture(blocks, [], 1000n);
    const store = new FakeStore();
    const { deps } = runnerDeps(source, fakeChain(1, "ethereum"), store);

    const [runner] = await runChains([deps]);
    const stored = [...store.blocks.values()].map((b) => b.number);
    expect(stored).toHaveLength(50);
    expect(Math.min(...stored.map(Number))).toBe(951);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(1000n);
    // no request below block 951
    const minRequested = Math.min(...source.getLogsCalls.map((c) => Number(c.fromBlock)));
    expect(minRequested).toBeGreaterThanOrEqual(951);
    await runner.stop();
  });

  it("chains.json start_block overrides START_BACKFILL_BLOCKS", async () => {
    const blocks = makeBlocks(900n, 1000n);
    const source = FakeSource.fromFixture(blocks, [], 1000n);
    const store = new FakeStore();
    const { deps } = runnerDeps(source, fakeChain(1, "ethereum", 990n), store);
    const [runner] = await runChains([deps]);
    const stored = [...store.blocks.values()].map((b) => b.number);
    expect(Math.min(...stored.map(Number))).toBe(991);
    await runner.stop();
  });
});

describe("head gap handling", () => {
  it("checkpoint 100, head 103 arrives -> 101-103 backfilled, checkpoint 103", async () => {
    const blocks = makeBlocks(100n, 103n);
    const source = FakeSource.fromFixture(blocks, [], 100n);
    const store = new FakeStore();
    await store.setCheckpoint(1, 99n, null); // runner.start backfills to head 100 -> checkpoint 100
    const { deps, captured } = runnerDeps(source, fakeChain(1, "ethereum"), store);
    const [runner] = await runChains([deps]);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(100n);

    // push a head that skipped 101-102
    const head = blocks.find((b) => b.number === 103n)!;
    captured.onBlock?.(head);
    await runner.drain();

    const stored = [...store.blocks.values()].map((b) => b.number).sort();
    expect(stored).toEqual([100n, 101n, 102n, 103n]);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(103n);
    await runner.stop();
  });
});

describe("per-filter log fetch", () => {
  it("one request per filter with its own address+topics; results merged and sorted", async () => {
    const blocks = makeBlocks(10n, 12n);
    const logs: SourceLog[] = [
      { ...mkLog(blocks[2], 0, "0x" + "9".repeat(64)), address: ADDR_B }, // B-scoped, block 12
      mkLog(blocks[0], 0, "0x" + "8".repeat(64)), // A log, block 10
      mkLog(blocks[2], 1, "0x" + "8".repeat(63) + "7"), // A log, block 12
    ];
    const source = FakeSource.fromFixture(blocks, logs, 12n);
    const out = await fetchLogs(source, [FILTER_A, FILTER_B], 10n, 12n, log);

    expect(source.getLogsCalls).toHaveLength(2);
    const callA = source.getLogsCalls.find((c) => c.topics[0][0] === "0xtopicA")!;
    const callB = source.getLogsCalls.find((c) => c.topics[0][0] === "0xtopicB")!;
    expect(callA.address).toBeUndefined();
    expect(callB.address).toBe(ADDR_B);
    // A is unscoped -> returns all three logs; B returns only its address's
    // 12:0 log (a duplicate identity the store upsert will dedup downstream).
    // Merged + stably sorted by (block, logIndex).
    expect(out.map((l) => `${l.blockNumber}:${l.logIndex}`)).toEqual(["10:0", "12:0", "12:0", "12:1"]);
  });
});

describe("provider result limits", () => {
  it("range-limit errors halve the window recursively down to success", async () => {
    const blocks = makeBlocks(100n, 107n);
    const logs = blocks.slice(1).map((b, i) => mkLog(b, i, "0x" + (i + 1).toString(16).padStart(64, "0")));
    const inner = FakeSource.fromFixture(blocks, logs, 107n);
    const source = new RangeLimitSource(inner, 2n); // max 3-block windows

    const out = await fetchFilterLogs(source, FILTER_A, 100n, 107n, log);
    expect(out).toHaveLength(7);
    // First attempt covers the full 7-block window and is rejected; the
    // source then receives only <=3-block windows until success.
    const widths = source.getLogsCalls.map((c) => Number(c.toBlock - c.fromBlock));
    expect(widths[0]).toBe(7);
    expect(source.getLogsCalls.length).toBeGreaterThan(4);
    expect(widths.slice(1).every((w) => w <= 3)).toBe(true);
  });
});

describe("transactions table", () => {
  it("two logs from one tx -> one transactions row", async () => {
    const blocks = makeBlocks(50n, 50n);
    const txHash = "0x" + "7".repeat(64);
    const logs = [mkLog(blocks[0], 0, txHash), mkLog(blocks[0], 1, txHash)];
    const source = FakeSource.fromFixture(blocks, logs, 50n);
    source.txs.set(txHash, {
      from: "0x" + "a".repeat(40),
      to: "0x" + "c".repeat(40),
      value: 123n,
      status: "success",
      blockNumber: 50n,
    });
    const store = new FakeStore();
    const stored = await ingestTransactions(logs, source, {
      chainId: 1,
      store,
      publisher: new FakePublisher(),
      log,
    });
    expect(stored).toBe(1);
    expect(store.txs.size).toBe(1);
    const row = store.txs.get(`1:${txHash}`)!;
    expect(row.sender).toBe("0x" + "a".repeat(40));
    expect(row.recipient).toBe("0x" + "c".repeat(40));
    expect(row.value).toBe("123");
    expect(row.status).toBe("success");
    expect(row.blockNumber).toBe(50n);
  });

  it("second ingest of the same logs makes zero tx RPC calls", async () => {
    const blocks = makeBlocks(50n, 50n);
    const txHash = "0x" + "7".repeat(64);
    const logs = [mkLog(blocks[0], 0, txHash), mkLog(blocks[0], 1, txHash)];
    const source = FakeSource.fromFixture(blocks, logs, 50n);
    const store = new FakeStore();
    const deps = { chainId: 1, store, publisher: new FakePublisher(), log };

    await ingestTransactions(logs, source, deps);
    expect(source.txRpcCalls).toBe(2); // tx + receipt, once
    source.txRpcCalls = 0;

    const again = await ingestTransactions(logs, source, deps);
    expect(again).toBe(0);
    expect(source.txRpcCalls).toBe(0);
  });

  it("ingestTransactions: false disables enrichment entirely", async () => {
    const blocks = makeBlocks(50n, 50n);
    const logs = [mkLog(blocks[0], 0, "0x" + "7".repeat(64))];
    const source = FakeSource.fromFixture(blocks, logs, 50n);
    const store = new FakeStore();
    const stored = await ingestTransactions(logs, source, {
      chainId: 1,
      store,
      publisher: new FakePublisher(),
      log,
      ingestTransactions: false,
    });
    expect(stored).toBe(0);
    expect(source.txRpcCalls).toBe(0);
    expect(store.txs.size).toBe(0);
  });
});
