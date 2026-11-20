import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { backfillRange, planChunks } from "../src/backfill.js";
import type { ParsedLogFilter } from "../src/subscriptions.js";
import {
  FakePublisher,
  FakeSource,
  FakeStore,
  loadFixture,
  toSourceBlocks,
  toSourceLogs,
  type FixtureBlocks,
  type FixtureLogs,
} from "./helpers.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const filters: ParsedLogFilter[] = [
  { name: "erc20_transfer", abiEvent: {} as never, topics: [["0xtransfer"]] },
];

function chain() {
  const blocks = toSourceBlocks(loadFixture<FixtureBlocks>("blocks_chain_b_fork.json"));
  const logs = toSourceLogs(loadFixture<FixtureLogs>("logs_chain_b_fork.json"));
  return FakeSource.fromFixture(blocks, logs);
}

describe("planChunks", () => {
  it("splits (fromExclusive, to] into bounded chunks", () => {
    expect(planChunks(100n, 106n, 2)).toEqual([
      [101n, 102n],
      [103n, 104n],
      [105n, 106n],
    ]);
    expect(planChunks(100n, 101n, 2000)).toEqual([[101n, 101n]]);
    expect(planChunks(106n, 106n, 2000)).toEqual([]);
  });
});

describe("backfillRange", () => {
  it("resume from checkpoint fills exactly the missing range", async () => {
    const source = chain();
    const store = new FakeStore();
    const publisher = new FakePublisher();
    const deps = { chainId: 1, store, publisher, log };

    // Checkpoint at 102: only 103..106 must be processed.
    await store.setCheckpoint(1, 102n, null);
    const res = await backfillRange(source, filters, deps, 106n, { chunkSize: 2 });

    expect(res.fromBlock).toBe(102n);
    expect(res.toBlock).toBe(106n);
    const storedNumbers = [...store.blocks.values()].map((b) => b.number).sort();
    expect(storedNumbers).toEqual([103n, 104n, 105n, 106n]);
    // fixture B logs live on blocks 103-106, one per block
    expect(store.logs.size).toBe(4);
    expect(publisher.events.filter((e) => e.kind === "log")).toHaveLength(4);
    // checkpoint ends at the head
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(106n);
  });

  it("backfill is idempotent across a restart", async () => {
    const source = chain();
    const store = new FakeStore();
    const publisher = new FakePublisher();
    const deps = { chainId: 1, store, publisher, log };

    await store.setCheckpoint(1, 99n, null);
    await backfillRange(source, filters, deps, 106n, { chunkSize: 2000 });
    const logCount = store.logs.size;
    const eventCount = publisher.events.length;

    // "Restart": simulate a kill mid-stream by rewinding nothing — the
    // checkpoint is already at head so a second run is a no-op.
    const again = await backfillRange(source, filters, deps, 106n, { chunkSize: 2000 });
    expect(again.logsInserted).toBe(0);
    expect(store.logs.size).toBe(logCount);
    expect(publisher.events).toHaveLength(eventCount);
  });

  it("no-op when checkpoint is already at head", async () => {
    const source = chain();
    const store = new FakeStore();
    await store.setCheckpoint(1, 200n, null);
    const res = await backfillRange(source, filters, { chainId: 1, store, publisher: new FakePublisher(), log }, 106n);
    expect(res.blocksStored).toBe(0);
  });
});
