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

export interface GetLogsCall {
  topics: string[][];
  address?: string | string[];
  fromBlock: bigint;
  toBlock: bigint;
}

/** Deterministic block/log source serving a fixed fixture chain. */
export class FakeSource implements ChainSource {
  getLogsCalls: GetLogsCall[] = [];
  /** Optional canned transactions by hash. */
  txs = new Map<string, { from: string; to: string | null; value: bigint; status: "success" | "reverted"; blockNumber: bigint }>();

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
  async getLogs(args: GetLogsCall): Promise<SourceLog[]> {
    this.getLogsCalls.push(args);
    const addrs = args.address === undefined ? null : (Array.isArray(args.address) ? args.address : [args.address]).map((a) => a.toLowerCase());
    return this.logs.filter(
      (l) =>
        l.blockNumber >= args.fromBlock &&
        l.blockNumber <= args.toBlock &&
        (addrs === null || addrs.includes(l.address.toLowerCase()))
    );
  }
  async getTransaction(hash: string) {
    const t = this.txs.get(hash);
    return { hash, from: t?.from ?? "0x" + "2".repeat(40), to: t?.to ?? "0x" + "3".repeat(40), value: t?.value ?? 0n };
  }
  async getTransactionReceipt(hash: string) {
    const t = this.txs.get(hash);
    const log = this.logs.find((l) => l.transactionHash === hash);
    return { status: t?.status ?? ("success" as const), blockNumber: t?.blockNumber ?? log?.blockNumber ?? 0n };
  }
}

/** Rejects getLogs windows wider than maxRange with a provider-style limit error. */
export class RangeLimitSource extends FakeSource {
  constructor(source: FakeSource, private maxRange: bigint) {
    super(new Map(), [], source.head);
    this.inner = source;
  }
  private inner: FakeSource;
  override async getBlockNumber() {
    return this.inner.getBlockNumber();
  }
  override async getBlock(n: bigint) {
    return this.inner.getBlock(n);
  }
  override async getLogs(args: GetLogsCall): Promise<SourceLog[]> {
    this.getLogsCalls.push(args);
    if (args.toBlock - args.fromBlock > this.maxRange) {
      throw new Error("query returned more than 10000 results");
    }
    return this.inner.getLogs(args);
  }
}

/** Build a SourceBlock chain [from, to] with deterministic synthetic hashes. */
export function makeBlocks(from: bigint, to: bigint): SourceBlock[] {
  const out: SourceBlock[] = [];
  const h = (label: string) => "0x" + label.padStart(64, "0").slice(-64);
  for (let n = from; n <= to; n++) {
    out.push({
      number: n,
      hash: h(`b${n}`),
      parentHash: n === from ? h(`p${n}`) : h(`b${n - 1n}`),
      timestamp: 1_700_000_000n + n * 12n,
    });
  }
  return out;
}

/** viem-shaped client facades over a ChainSource for ChainRunner tests. */
export function fakeClients(source: ChainSource) {
  const captured: { onBlock?: (b: SourceBlock) => void } = {};
  const ws = {
    watchBlocks: (args: { onBlock: (b: unknown) => void }) => {
      captured.onBlock = args.onBlock as (b: SourceBlock) => void;
      return () => {};
    },
    watchEvent: () => () => {},
  };
  const http = {
    getBlockNumber: () => source.getBlockNumber(),
    getBlock: ({ blockNumber }: { blockNumber: bigint }) => source.getBlock(blockNumber),
    getLogs: (args: { topics: string[][]; address?: string | string[]; fromBlock: bigint; toBlock: bigint }) =>
      source.getLogs(args),
    getTransaction: ({ hash }: { hash: string }) => source.getTransaction(hash),
    getTransactionReceipt: ({ hash }: { hash: string }) => source.getTransactionReceipt(hash),
  };
  const clients = { role: "primary" as const, ws: ws as never, http: http as never };
  return { primary: clients, captured };
}
