import { describe, expect, it } from "vitest";
import { createLogger } from "@nexus/shared-utils";
import { resolveReorg } from "../src/reorg.js";
import { backfillRange } from "../src/backfill.js";
import { ingestBlock } from "../src/ingest.js";
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

const blocksA = () => toSourceBlocks(loadFixture<FixtureBlocks>("blocks_chain_a.json"));
const blocksB = () => toSourceBlocks(loadFixture<FixtureBlocks>("blocks_chain_b_fork.json"));
const logsA = () => toSourceLogs(loadFixture<FixtureLogs>("logs_chain_a.json"));
const logsB = () => toSourceLogs(loadFixture<FixtureLogs>("logs_chain_b_fork.json"));

describe("reorg handling", () => {
  it("fork: non-canonical logs marked removed, checkpoint rewinds, canonical range reprocessed", async () => {
    const chainId = 1;
    const store = new FakeStore();
    const publisher = new FakePublisher();
    const deps = { chainId, store, publisher, log };

    // Ingest canonical chain A through block 106.
    await store.setCheckpoint(chainId, 99n, null);
    const sourceA = FakeSource.fromFixture(blocksA(), logsA());
    await backfillRange(sourceA, filters, deps, 106n, { chunkSize: 2000 });
    expect((await store.getCheckpoint(chainId))?.lastBlock).toBe(106n);
    const aLogs = [...store.logs.values()];
    expect(aLogs.length).toBe(3);
    expect(aLogs.every((l) => !l.removed)).toBe(true);

    // Chain reorganizes: source now serves fork B; a head at 106B arrives.
    const sourceB = FakeSource.fromFixture(blocksB(), logsB());
    const headB = blocksB().find((b) => b.number === 106n)!;
    const result = await resolveReorg(headB, sourceB, store, chainId, 12, log);

    expect(result.reorged).toBe(true);
    expect(result.ancestor).toBe(102n);
    expect(result.orphaned.sort()).toEqual([103n, 104n, 105n]);

    // Non-canonical logs flagged removed = TRUE.
    const removedFlags = [...store.logs.values()].map((l) => l.removed);
    expect(removedFlags).toEqual([true, true, true]);

    // Checkpoint rewound to the common ancestor.
    expect((await store.getCheckpoint(chainId))?.lastBlock).toBe(102n);

    // Backfill reprocesses the canonical range from B.
    await backfillRange(sourceB, filters, deps, 106n, { chunkSize: 2000 });
    const all = [...store.logs.values()];
    const canonical = all.filter((l) => !l.removed);
    expect(canonical).toHaveLength(4); // B-side logs at 103..106
    expect(canonical.every((l) => blocksB().some((b) => b.hash === l.blockHash))).toBe(true);
    expect((await store.getCheckpoint(chainId))?.lastBlock).toBe(106n);
  });

  it("matching parent hash -> no reorg", async () => {
    const store = new FakeStore();
    const publisher = new FakePublisher();
    const deps = { chainId: 1, store, publisher, log };
    await store.setCheckpoint(1, 99n, null);
    const sourceA = FakeSource.fromFixture(blocksA(), logsA());
    await backfillRange(sourceA, filters, deps, 105n, { chunkSize: 2000 });

    const head = blocksA().find((b) => b.number === 106n)!;
    const result = await resolveReorg(head, sourceA, store, 1, 12, log);
    expect(result.reorged).toBe(false);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(105n);
  });

  it("stored blocks keep both fork sides after reorg resolution", async () => {
    const store = new FakeStore();
    const deps = { chainId: 1, store, publisher: new FakePublisher(), log };
    for (const b of blocksA()) await ingestBlock(b, deps);
    const sourceB = FakeSource.fromFixture(blocksB(), logsB());
    const headB = blocksB().find((b) => b.number === 104n)!;
    const result = await resolveReorg(headB, sourceB, store, 1, 12, log);
    expect(result.reorged).toBe(true);
    // A-side hashes remain in the blocks table (history), logs are what's flagged.
    const at103 = await store.getBlockByNumber(1, 103n);
    expect(at103.map((b) => b.hash)).toContain(blocksA()[3].hash);
  });

  it("publishes one block_removed event per orphaned block, once on replay", async () => {
    const chainId = 1;
    const store = new FakeStore();
    const published: Array<Record<string, unknown>> = [];
    // Mirror runner.ts: marker insert gates publication.
    const onOrphaned = async (b: { number: bigint; hash: string }) => {
      if (await store.insertRemovedBlock(chainId, b.hash)) {
        published.push({
          chain_id: chainId,
          kind: "block_removed",
          dedup_key: `${chainId}:${b.hash}:removed`,
          block_number: Number(b.number),
          payload: { block_hash: b.hash, block_number: Number(b.number) },
        });
      }
    };
    await store.setCheckpoint(chainId, 99n, null);
    const sourceA = FakeSource.fromFixture(blocksA(), logsA());
    await backfillRange(sourceA, filters, { chainId, store, publisher: new FakePublisher(), log }, 106n, { chunkSize: 2000 });

    const sourceB = FakeSource.fromFixture(blocksB(), logsB());
    const headB = blocksB().find((b) => b.number === 106n)!;
    const result = await resolveReorg(headB, sourceB, store, chainId, 12, log, onOrphaned);

    expect(result.orphaned.sort()).toEqual([103n, 104n, 105n]);
    expect(published).toHaveLength(3);
    for (const ev of published) {
      expect(ev.kind).toBe("block_removed");
      expect((ev.dedup_key as string).endsWith(":removed")).toBe(true);
      expect(blocksA().some((b) => b.hash === (ev.payload as { block_hash: string }).block_hash)).toBe(true);
    }

    // Replaying the same reorg must not republish (removed_blocks marker).
    published.length = 0;
    await resolveReorg(headB, sourceB, store, chainId, 12, log, onOrphaned);
    expect(published).toHaveLength(0);
  });
});
