// Test fakes: in-memory EventStore, EventPublisher, and ChainSource built
// from the recorded fixtures. Production paths use PgStore/RedisPublisher/viem.

import { readFileSync } from "node:fs";
import type { EventStore, StoredBlock, StoredLog, StoredTransaction, Checkpoint, UpsertResult } from "../src/store.js";
import type { EventPublisher } from "../src/publisher.js";
import type { ChainSource, SourceBlock, SourceLog } from "../src/rpc.js";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";

export function loadFixture<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

export interface FixtureBlocks {
  blocks: Array<{ number: number; hash: string; parentHash: string; timestamp: number }>;
}
export interface FixtureLogs {
  logs: Array<Omit<SourceLog, "blockNumber"> & { blockNumber: number }>;
}

export function toSourceBlocks(fx: FixtureBlocks): SourceBlock[] {
  return fx.blocks.map((b) => ({ ...b, number: BigInt(b.number), timestamp: BigInt(b.timestamp) }));
}
export function toSourceLogs(fx: FixtureLogs): SourceLog[] {
  return fx.logs.map((l) => ({ ...l, blockNumber: BigInt(l.blockNumber) }));
}

/** In-memory store honoring the same identity keys + ON CONFLICT semantics. */
export class FakeStore implements EventStore {
  blocks = new Map<string, StoredBlock>(); // key: chainId:hash
  logs = new Map<string, StoredLog>(); // key: chainId:blockHash:txHash:logIndex
  txs = new Map<string, StoredTransaction>(); // key: chainId:hash
  checkpoints = new Map<number, Checkpoint>();
  healthRows: Array<{ provider: string; chainId: number; latencyMs: number; errors: number }> = [];

  async upsertBlock(b: StoredBlock): Promise<UpsertResult> {
    const k = `${b.chainId}:${b.hash}`;
    if (this.blocks.has(k)) return "duplicate";
    this.blocks.set(k, { ...b });
    return "inserted";
  }
  async upsertLog(l: StoredLog): Promise<UpsertResult> {
    const k = `${l.chainId}:${l.blockHash}:${l.transactionHash}:${l.logIndex}`;
    if (this.logs.has(k)) return "duplicate";
    this.logs.set(k, { ...l });
    return "inserted";
  }
  async upsertTransaction(t: StoredTransaction): Promise<UpsertResult> {
    const k = `${t.chainId}:${t.hash}`;
    if (this.txs.has(k)) return "duplicate";
    this.txs.set(k, { ...t });
    return "inserted";
  }
  async markLogsRemoved(chainId: number, blockHash: string): Promise<number> {
    let n = 0;
    for (const l of this.logs.values()) {
      if (l.chainId === chainId && l.blockHash === blockHash && !l.removed) {
        l.removed = true;
        n++;
      }
    }
    return n;
  }
  async getBlockByNumber(chainId: number, number: bigint): Promise<StoredBlock[]> {
    return [...this.blocks.values()].filter((b) => b.chainId === chainId && b.number === number);
  }
  async getCheckpoint(chainId: number): Promise<Checkpoint | null> {
    return this.checkpoints.get(chainId) ?? null;
  }
  async setCheckpoint(chainId: number, lastBlock: bigint, lastLogCursor: string | null): Promise<void> {
    this.checkpoints.set(chainId, { chainId, lastBlock, lastLogCursor });
  }
  async recordProviderHealth(row: { provider: string; chainId: number; latencyMs: number; errors: number }): Promise<void> {
    this.healthRows.push(row);
  }
  async close(): Promise<void> {}
}

export class FakePublisher implements EventPublisher {
  events: NexusNormalizedEvent[] = [];
  async publish(e: NexusNormalizedEvent): Promise<void> {
    this.events.push(e);
  }
  async close(): Promise<void> {}
}

/** Deterministic block/log source serving a fixed fixture chain. */
export class FakeSource implements ChainSource {
  constructor(
    private blocksByNumber: Map<bigint, SourceBlock>,
    private logs: SourceLog[],
    public head: bigint
  ) {}
  static fromFixture(blocks: SourceBlock[], logs: SourceLog[], head?: bigint): FakeSource {
    const map = new Map(blocks.map((b) => [b.number, b]));
    return new FakeSource(map, logs, head ?? blocks[blocks.length - 1].number);
  }
  async getBlockNumber(): Promise<bigint> {
    return this.head;
  }
  async getBlock(n: bigint): Promise<SourceBlock> {
    const b = this.blocksByNumber.get(n);
    if (!b) throw new Error(`fixture: no block ${n}`);
    return b;
  }
  async getLogs(args: { topics: string[][]; fromBlock: bigint; toBlock: bigint }): Promise<SourceLog[]> {
    return this.logs.filter((l) => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock);
  }
}
