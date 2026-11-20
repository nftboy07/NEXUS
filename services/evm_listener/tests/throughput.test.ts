// Pipelined backfill: prefetch window + shared RPC limiter must not change
// ordering, checkpoint, or dedup guarantees.

import { describe, expect, it } from "vitest";
import pg from "pg";
import { createLogger } from "@nexus/shared-utils";
import { backfillRange, isRangeLimitError, isRateLimitError } from "../src/backfill.js";
import { backfillOptionsFromEnv, ingestOptionsFromEnv } from "../src/config.js";
import { createLimiter, limitSource, type SourceBlock, type SourceBlockReceipt, type SourceBlockWithTransactions, type SourceLog } from "../src/rpc.js";
import { PgStore, type StoredLog } from "../src/store.js";
import type { ParsedLogFilter } from "../src/subscriptions.js";
import { FakePublisher, FakeSource, FakeStore, makeBlocks } from "./helpers.js";

const log = createLogger("test", { sink: () => {}, minLevel: "error" });
const filters: ParsedLogFilter[] = [
  { name: "a", abiEvent: {} as never, topics: [["0xtransfer"]], address: ["0x" + "a".repeat(40)] },
  { name: "b", abiEvent: {} as never, topics: [["0xtransfer"]], address: ["0x" + "b".repeat(40)] },
];
const hex = (s: string) => "0x" + s.padStart(64, "0").slice(-64);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Blocks 1..n, each with `perBlock` logs from distinct txs across 2 contracts. */
function syntheticChain(n: bigint, perBlock = 3) {
  const blocks = makeBlocks(1n, n);
  const logs: SourceLog[] = [];
  for (const b of blocks) {
    for (let i = 0; i < perBlock; i++) {
      logs.push({
        address: "0x" + (i % 2 ? "b" : "a").repeat(40),
        blockHash: b.hash,
        blockNumber: b.number,
        transactionHash: hex(`t${b.number}x${i}`),
        logIndex: i,
        data: "0x01",
        topics: ["0xtransfer"],
      });
    }
  }
  return { blocks, logs };
}

/** Deterministic, uneven per-call latency so prefetches finish out of order,
 * plus in-flight accounting and optional full-block / block-receipt support. */
class JitterSource extends FakeSource {
  inflight = 0;
  maxInflight = 0;
  blockCalls = 0;
  fullBlockCalls = 0;
  blockReceiptCalls = 0;
  failBlock: bigint | null = null;
  blockReceiptsBroken = false;
  constructor(private blockList: SourceBlock[], private logList: SourceLog[], private withBlockApis = false) {
    super(new Map(blockList.map((b) => [b.number, b])), logList, blockList[blockList.length - 1].number);
    if (!withBlockApis) {
      // Mimic a source without the optional block-level APIs.
      (this as { getBlockWithTransactions?: unknown }).getBlockWithTransactions = undefined;
      (this as { getBlockReceipts?: unknown }).getBlockReceipts = undefined;
    }
  }
  private async track<T>(key: bigint, fn: () => Promise<T>): Promise<T> {
    this.inflight++;
    this.maxInflight = Math.max(this.maxInflight, this.inflight);
    try {
      await sleep(Number((key * 7n) % 5n)); // 0-4ms, uneven by block
      return await fn();
    } finally {
      this.inflight--;
    }
  }
  override async getBlock(n: bigint) {
    this.blockCalls++;
    return this.track(n, async () => {
      if (n === this.failBlock) throw new Error(`boom at ${n}`);
      return super.getBlock(n);
    });
  }
  override async getLogs(args: Parameters<FakeSource["getLogs"]>[0]) {
    return this.track(args.fromBlock, () => super.getLogs(args));
  }
  override async getTransaction(h: string) {
    return this.track(BigInt(h.length), () => super.getTransaction(h));
  }
  override async getTransactionReceipt(h: string) {
    return this.track(BigInt(h.length + 1), () => super.getTransactionReceipt(h));
  }
  async getBlockWithTransactions(n: bigint): Promise<SourceBlockWithTransactions> {
    this.fullBlockCalls++;
    const b = await this.getBlock(n);
    const txs = this.logList.filter((l) => l.blockNumber === n).map((l) => ({
      hash: l.transactionHash, from: "0x" + "2".repeat(40), to: "0x" + "3".repeat(40), value: 5n, nonce: 1n, blockHash: b.hash,
    }));
    return { ...b, transactions: txs };
  }
  async getBlockReceipts(n: bigint): Promise<SourceBlockReceipt[]> {
    this.blockReceiptCalls++;
    if (this.blockReceiptsBroken) throw new Error("the method eth_getBlockReceipts does not exist");
    return this.logList.filter((l) => l.blockNumber === n).map((l) => ({
      transactionHash: l.transactionHash, status: "success" as const, blockNumber: n,
    }));
  }
}

/** Store that asserts, at every checkpoint write, that block n and all its
 * logs are already stored AND published (the core checkpoint guarantee). */
class CheckingStore extends FakeStore {
  writes: bigint[] = [];
  violations: string[] = [];
  constructor(private publisher: FakePublisher, private logsByBlock: Map<bigint, SourceLog[]>) {
    super();
  }
  override async setCheckpoint(chainId: number, lastBlock: bigint, cursor: string | null) {
    if (this.writes.length > 0 || this.checkpoints.has(chainId)) {
      const blockStored = [...this.blocks.values()].some((b) => b.number === lastBlock);
      if (!blockStored) this.violations.push(`block ${lastBlock} not stored at checkpoint`);
      for (const l of this.logsByBlock.get(lastBlock) ?? []) {
        const k = `${chainId}:${l.blockHash}:${l.transactionHash}:${l.logIndex}`;
        if (!this.logs.has(k)) this.violations.push(`log ${k} not stored at checkpoint`);
        if (!this.publisher.events.some((e) => e.dedup_key === k)) this.violations.push(`log ${k} not published at checkpoint`);
      }
      const prev = this.writes[this.writes.length - 1];
      if (prev !== undefined && lastBlock !== prev + 1n) this.violations.push(`checkpoint jumped ${prev} -> ${lastBlock}`);
      this.writes.push(lastBlock);
    }
    await super.setCheckpoint(chainId, lastBlock, cursor);
  }
}

function groupByBlock(logs: SourceLog[]) {
  const m = new Map<bigint, SourceLog[]>();
  for (const l of logs) m.set(l.blockNumber, [...(m.get(l.blockNumber) ?? []), l]);
  return m;
}

async function run(opts: { blockConcurrency: number; rpcConcurrency: number }, n = 40n) {
  const { blocks, logs } = syntheticChain(n);
  const source = new JitterSource(blocks, logs);
  const publisher = new FakePublisher();
  const store = new CheckingStore(publisher, groupByBlock(logs));
  await store.setCheckpoint(1, 0n, null);
  const deps = { chainId: 1, store, publisher, log };
  await backfillRange(source, filters, deps, n, { chunkSize: 16, ...opts });
  return { source, store, publisher, logs };
}

describe("pipelined backfill", () => {
  it("concurrent prefetch yields the same rows + event order as sequential", async () => {
    const seq = await run({ blockConcurrency: 1, rpcConcurrency: 1 });
    const par = await run({ blockConcurrency: 8, rpcConcurrency: 4 });
    expect(par.publisher.events.map((e) => e.dedup_key)).toEqual(seq.publisher.events.map((e) => e.dedup_key));
    expect([...par.store.logs.keys()].sort()).toEqual([...seq.store.logs.keys()].sort());
    expect(par.store.txs.size).toBe(seq.logs.length);
    expect(par.store.blocks.size).toBe(40);
    // Events are strictly block-ordered: block event for n after n's logs, before n+1's.
    const blockNums = par.publisher.events.map((e) => e.block_number ?? -1);
    expect(blockNums).toEqual([...blockNums].sort((a, b) => a - b));
    expect(par.store.violations).toEqual([]);
    expect(par.store.writes).toEqual(Array.from({ length: 40 }, (_, i) => BigInt(i + 1)));
  });

  it("never exceeds RPC_MAX_CONCURRENCY in-flight requests", async () => {
    const { source } = await run({ blockConcurrency: 16, rpcConcurrency: 3 });
    expect(source.maxInflight).toBeLessThanOrEqual(3);
    expect(source.maxInflight).toBeGreaterThan(1);
  });

  it("failure at block K: checkpoint K-1, nothing past K-1 written; restart resumes with no gaps/dupes", async () => {
    const n = 30n;
    const { blocks, logs } = syntheticChain(n);
    const source = new JitterSource(blocks, logs);
    source.failBlock = 17n;
    const publisher = new FakePublisher();
    const store = new CheckingStore(publisher, groupByBlock(logs));
    await store.setCheckpoint(1, 0n, null);
    const deps = { chainId: 1, store, publisher, log };
    await expect(backfillRange(source, filters, deps, n, { chunkSize: 2000, blockConcurrency: 8, rpcConcurrency: 4 }))
      .rejects.toThrow(/boom at 17/);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(16n);
    expect(Math.max(...[...store.blocks.values()].map((b) => Number(b.number)))).toBe(16);
    expect(Math.max(...publisher.events.map((e) => e.block_number ?? 0))).toBe(16);
    expect([...store.logs.values()].every((l) => blocks.find((b) => b.hash === l.blockHash)!.number <= 16n)).toBe(true);

    source.failBlock = null; // provider recovers; restart
    await backfillRange(source, filters, deps, n, { chunkSize: 2000, blockConcurrency: 8, rpcConcurrency: 4 });
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(n);
    expect(store.blocks.size).toBe(30);
    expect(store.logs.size).toBe(logs.length);
    const keys = publisher.events.map((e) => e.dedup_key);
    expect(new Set(keys).size).toBe(keys.length); // nothing published twice
    expect(keys.length).toBe(logs.length + 30);
    expect(store.violations).toEqual([]);
  });
});

describe("block-level tx enrichment", () => {
  async function enrich(mode: "auto" | "tx" | "block", opts: { threshold?: number; brokenReceipts?: boolean } = {}) {
    const { blocks, logs } = syntheticChain(10n, 5);
    const source = new JitterSource(blocks, logs, true);
    source.blockReceiptsBroken = opts.brokenReceipts ?? false;
    const store = new FakeStore();
    await store.setCheckpoint(1, 0n, null);
    const deps = { chainId: 1, store, publisher: new FakePublisher(), log, txEnrichMode: mode, blockEnrichThreshold: opts.threshold };
    await backfillRange(source, filters, deps, 10n, { blockConcurrency: 4, rpcConcurrency: 4 });
    return { source, store, logs };
  }

  it("block mode: one full block + one block-receipts call per block, zero per-tx calls", async () => {
    const { source, store, logs } = await enrich("block");
    expect(store.txs.size).toBe(logs.length);
    expect(source.txRpcCalls).toBe(0);
    expect(source.fullBlockCalls).toBe(10);
    expect(source.blockReceiptCalls).toBe(10);
    const t = [...store.txs.values()][0];
    expect(t.status).toBe("success");
    expect(t.nonce).toBe(1n);
    expect(t.blockHash).toMatch(/^0x/);
  });

  it("auto mode below threshold stays per-tx", async () => {
    const { source, store } = await enrich("auto", { threshold: 6 });
    expect(source.fullBlockCalls).toBe(0);
    expect(source.txRpcCalls).toBe(2 * store.txs.size);
  });

  it("auto mode at threshold switches to block-level", async () => {
    const { source } = await enrich("auto", { threshold: 5 });
    expect(source.fullBlockCalls).toBe(10);
    expect(source.txRpcCalls).toBe(0);
  });

  it("eth_getBlockReceipts unsupported -> per-tx receipts only (no getTransaction)", async () => {
    const { source, store, logs } = await enrich("block", { brokenReceipts: true });
    expect(store.txs.size).toBe(logs.length);
    expect(source.txRpcCalls).toBe(logs.length); // receipts only
  });
});

describe("rpc limiter + error classification", () => {
  it("createLimiter caps concurrency and runs everything", async () => {
    const run = createLimiter(2);
    let active = 0;
    let peak = 0;
    const out = await Promise.all(
      [1, 2, 3, 4, 5].map((i) => run(async () => {
        active++; peak = Math.max(peak, active);
        await sleep(2);
        active--;
        return i;
      }))
    );
    expect(out).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it("limitSource keeps optional block APIs only when the source has them", () => {
    const { blocks, logs } = syntheticChain(2n);
    expect(limitSource(new JitterSource(blocks, logs, true), 2).getBlockReceipts).toBeTypeOf("function");
    expect(limitSource(new JitterSource(blocks, logs, false), 2).getBlockReceipts).toBeUndefined();
  });

  it("rate-limit responses are not treated as range-too-large (no split storm)", () => {
    const msg = "Rate limit exceeded. To obtain higher limits, please request a personal token";
    expect(isRateLimitError(new Error(msg))).toBe(true);
    expect(isRangeLimitError(new Error(msg))).toBe(false);
    expect(isRangeLimitError(new Error("query returned more than 10000 results"))).toBe(true);
    expect(isRangeLimitError(new Error("exceed maximum block range: 50000"))).toBe(true);
  });
});

/** Throttles the first `n` calls of each block's getBlock with a viem-shaped 429. */
class ThrottlingSource extends JitterSource {
  throttled = 0;
  private hits = new Map<bigint, number>();
  constructor(blocks: SourceBlock[], logs: SourceLog[], private perBlock: number) {
    super(blocks, logs);
  }
  override async getBlock(n: bigint) {
    const h = this.hits.get(n) ?? 0;
    if (h < this.perBlock) {
      this.hits.set(n, h + 1);
      this.throttled++;
      throw Object.assign(new Error("HTTP request failed. Status: 429 URL: https://base-rpc.publicnode.com"), { status: 429 });
    }
    return super.getBlock(n);
  }
}

describe("rate-limit backoff (429 / -32005)", () => {
  it("classifies viem-shaped errors by status/code, not just message text", () => {
    expect(isRateLimitError(Object.assign(new Error("HTTP request failed."), { status: 429 }))).toBe(true);
    expect(isRateLimitError(new Error("wrapped", { cause: Object.assign(new Error("Request exceeds defined limit"), { code: -32005 }) }))).toBe(true);
    // Infura-style result-size -32005 must still split, not back off.
    const big = Object.assign(new Error("query returned more than 10000 results"), { code: -32005 });
    expect(isRateLimitError(big)).toBe(false);
    expect(isRangeLimitError(big)).toBe(true);
  });

  it("backfill backs off and completes (no stall, no gaps/dupes) under 429s", async () => {
    const n = 20n;
    const { blocks, logs } = syntheticChain(n);
    const raw = new ThrottlingSource(blocks, logs, 2);
    const hits: number[] = [];
    const source = limitSource(raw, 4, { rateLimitBaseMs: 2, rateLimitCapMs: 20, onRateLimit: (i) => hits.push(i.cooldownMs) });
    const publisher = new FakePublisher();
    const store = new CheckingStore(publisher, groupByBlock(logs));
    await store.setCheckpoint(1, 0n, null);
    await backfillRange(source, filters, { chainId: 1, store, publisher, log }, n, { blockConcurrency: 8, rpcConcurrency: 4 });
    expect(raw.throttled).toBe(40);
    expect(hits.length).toBe(40);
    expect((await store.getCheckpoint(1))?.lastBlock).toBe(n);
    const keys = publisher.events.map((e) => e.dedup_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.length).toBe(logs.length + 20);
    expect(store.violations).toEqual([]);
  });

  it("a 429 pauses every call through the source (shared cooldown) and resets on success", async () => {
    let calls = 0;
    const starts: number[] = [];
    const fake = {
      getBlockNumber: async () => {
        starts.push(Date.now());
        if (calls++ === 0) throw Object.assign(new Error("Too Many Requests"), { status: 429 });
        return 1n;
      },
    } as unknown as Parameters<typeof limitSource>[0];
    const src = limitSource(fake, 4, { rateLimitBaseMs: 60, rateLimitCapMs: 60 });
    const t0 = Date.now();
    const first = src.getBlockNumber();
    await sleep(5);
    await Promise.all([first, src.getBlockNumber(), src.getBlockNumber()]);
    // Calls issued during the cooldown waited for it (>= ~0.8 * 60ms).
    expect(Math.min(...starts.slice(2)) - t0).toBeGreaterThanOrEqual(45);
  });

  it("gives up after rateLimitRetries so the runner's outer retry can take over", async () => {
    let calls = 0;
    const fake = {
      getBlockNumber: async () => { calls++; throw Object.assign(new Error("x"), { status: 429 }); },
    } as unknown as Parameters<typeof limitSource>[0];
    const src = limitSource(fake, 1, { rateLimitRetries: 3, rateLimitBaseMs: 1, rateLimitCapMs: 2 });
    await expect(src.getBlockNumber()).rejects.toThrow("x");
    expect(calls).toBe(4);
  });

  it("limitSource is idempotent (live path + backfill share one budget)", () => {
    const { blocks, logs } = syntheticChain(2n);
    const once = limitSource(new JitterSource(blocks, logs), 2);
    expect(limitSource(once, 8)).toBe(once);
  });
});

describe("throughput env config", () => {
  it("defaults are safe for free public RPCs", () => {
    expect(backfillOptionsFromEnv({})).toEqual({ chunkSize: 2000, blockConcurrency: 8, rpcConcurrency: 8 });
    expect(ingestOptionsFromEnv({})).toEqual({
      ingestTransactions: true, txFetchConcurrency: 8, txEnrichMode: "auto", blockEnrichThreshold: 4,
    });
  });
  it("parses overrides and rejects junk", () => {
    expect(backfillOptionsFromEnv({ BACKFILL_BLOCK_CONCURRENCY: "1", RPC_MAX_CONCURRENCY: "2" }).blockConcurrency).toBe(1);
    expect(ingestOptionsFromEnv({ TX_ENRICH_MODE: "TX" }).txEnrichMode).toBe("tx");
    expect(() => backfillOptionsFromEnv({ RPC_MAX_CONCURRENCY: "0" })).toThrow(/RPC_MAX_CONCURRENCY/);
    expect(() => ingestOptionsFromEnv({ TX_ENRICH_MODE: "fast" })).toThrow(/TX_ENRICH_MODE/);
  });
});

// Real Postgres batch upserts: run with TEST_DATABASE_URL pointing at a
// scratch database that has the migrations applied.
describe.skipIf(!process.env.TEST_DATABASE_URL)("PgStore batch upserts (live Postgres)", () => {
  it("upsertLogs: one round trip, inserted/duplicate aligned, in-batch repeats count once", async () => {
    const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    const store = new PgStore(pool);
    const chainId = 999_001;
    await pool.query("DELETE FROM logs WHERE chain_id = $1", [chainId]);
    await pool.query("DELETE FROM transactions WHERE chain_id = $1", [chainId]);
    const mk = (i: number): StoredLog => ({
      chainId, blockHash: hex("bh"), transactionHash: hex(`t${i}`), logIndex: i,
      contract: "0x" + "a".repeat(40), topics: ["0xabc", "0x\"quoted\""], data: "0x", removed: false,
    });
    expect(await store.upsertLogs([mk(1), mk(2), mk(1)])).toEqual(["inserted", "inserted", "duplicate"]);
    expect(await store.upsertLogs([mk(2), mk(3)])).toEqual(["duplicate", "inserted"]);
    const { rows } = await pool.query("SELECT topics FROM logs WHERE chain_id = $1 AND log_index = 1", [chainId]);
    expect(rows[0].topics).toEqual(["0xabc", "0x\"quoted\""]);
    await store.upsertTransactions([
      { chainId, hash: hex("t1"), sender: "0x1", recipient: null, value: "12345678901234567890", status: "success", blockNumber: 7n, nonce: 3n, blockHash: hex("bh") },
      { chainId, hash: hex("t1"), sender: "0x1", recipient: null, value: "12345678901234567890", status: "success", blockNumber: 7n, nonce: 3n, blockHash: hex("bh") },
    ]);
    const tx = await pool.query("SELECT value::text, nonce, block_number FROM transactions WHERE chain_id = $1", [chainId]);
    expect(tx.rows).toEqual([{ value: "12345678901234567890", nonce: "3", block_number: "7" }]);
    await pool.query("DELETE FROM logs WHERE chain_id = $1", [chainId]);
    await pool.query("DELETE FROM transactions WHERE chain_id = $1", [chainId]);
    await pool.end();
  });
});
