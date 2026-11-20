import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { ingestLogs } from "../src/ingest.js";
import { FakePublisher, FakeStore, loadFixture, toSourceLogs, type FixtureLogs } from "./helpers.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });

describe("dedup", () => {
  it("same log delivered twice -> one stored row, one published event", async () => {
    const { logs } = loadFixture<FixtureLogs>("logs_chain_b_fork.json");
    const source = toSourceLogs({ logs });
    const store = new FakeStore();
    const publisher = new FakePublisher();
    const deps = { chainId: 1, store, publisher, log };

    const first = await ingestLogs(source, deps);
    expect(first.inserted).toBe(source.length);
    expect(first.duplicates).toBe(0);

    // Redelivery: identical logs again (reconnect, overlapping subscriptions)
    const second = await ingestLogs(source, deps);
    expect(second.inserted).toBe(0);
    expect(second.duplicates).toBe(source.length);

    expect(store.logs.size).toBe(source.length);
    expect(publisher.events).toHaveLength(source.length);
  });

  it("dedup keys are unique per (block_hash, tx_hash, log_index)", async () => {
    const { logs } = loadFixture<FixtureLogs>("logs_chain_b_fork.json");
    const keys = toSourceLogs({ logs }).map(
      (l) => `${l.blockHash}:${l.transactionHash}:${l.logIndex}`
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
