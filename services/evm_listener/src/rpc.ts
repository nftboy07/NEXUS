// viem public clients per chain: WebSocket + HTTP, primary and secondary.

import { createPublicClient, formatLog, http, numberToHex, webSocket, type PublicClient, type RpcLog } from "viem";
import type { ChainConfig } from "./config.js";

export type ProviderRole = "primary" | "secondary";

export interface ChainClients {
  role: ProviderRole;
  ws: PublicClient;
  http: PublicClient;
}

function makeClients(role: ProviderRole, wssUrl: string, httpUrl: string): ChainClients {
  return {
    role,
    ws: createPublicClient({ transport: webSocket(wssUrl) }),
    // Callers (backfill/ingest) already retry with backoff; viem's default 3
    // inner retries x 10s timeout delayed dead-endpoint errors by ~1 min.
    http: createPublicClient({
      transport: http(httpUrl, { retryCount: 1, timeout: Number(process.env.RPC_TIMEOUT_MS ?? 10_000) }),
    }),
  };
}

/** Primary clients, plus secondary clients when both secondary envs are set. */
export function createChainClients(chain: ChainConfig): { primary: ChainClients; secondary?: ChainClients } {
  const primary = makeClients("primary", chain.wssUrl, chain.httpUrl);
  const secondary =
    chain.wssUrlSecondary && chain.httpUrlSecondary
      ? makeClients("secondary", chain.wssUrlSecondary, chain.httpUrlSecondary)
      : undefined;
  return { primary, secondary };
}

/** Minimal block/log source abstraction — implemented by viem clients in production and fakes in tests. */
export interface SourceBlock {
  number: bigint;
  hash: string;
  parentHash: string;
  timestamp: bigint;
}

export interface SourceLog {
  address: string;
  blockHash: string;
  blockNumber: bigint;
  transactionHash: string;
  logIndex: number;
  data: string;
  topics: string[];
  transactionIndex?: number | null;
  removed?: boolean;
}

export interface SourceTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: bigint;
  nonce?: bigint;
  blockHash?: string | null;
}

export interface SourceReceipt {
  status: "success" | "reverted";
  blockNumber: bigint;
}

export interface SourceBlockWithTransactions extends SourceBlock {
  transactions: SourceTransaction[];
}

export interface SourceBlockReceipt extends SourceReceipt {
  transactionHash: string;
}

export interface ChainSource {
  getBlockNumber(): Promise<bigint>;
  getBlock(n: bigint): Promise<SourceBlock>;
  getLogs(args: {
    topics: (string[] | null)[];
    address?: string | string[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<SourceLog[]>;
  getTransaction(hash: string): Promise<SourceTransaction>;
  getTransactionReceipt(hash: string): Promise<SourceReceipt>;
  /** Block header + full tx objects in one call (eth_getBlockByNumber, true).
   * Optional: block-level enrichment falls back to per-tx calls without it. */
  getBlockWithTransactions?(n: bigint): Promise<SourceBlockWithTransactions>;
  /** All receipts of a block in one call (eth_getBlockReceipts). Optional. */
  getBlockReceipts?(n: bigint): Promise<SourceBlockReceipt[]>;
}

export function viemChainSource(client: PublicClient): ChainSource {
  return {
    getBlockNumber: () => client.getBlockNumber(),
    getBlock: async (n) => {
      const b = await client.getBlock({ blockNumber: n });
      return {
        number: b.number,
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: b.timestamp,
      };
    },
    getLogs: async ({ topics, address, fromBlock, toBlock }) => {
      // Raw eth_getLogs: viem's getLogs() ignores a `topics` param (it only
      // builds topics from event/args), which silently unscoped every filter.
      const raw = (await client.request({
        method: "eth_getLogs",
        params: [{ address: address as never, topics: topics as never, fromBlock: numberToHex(fromBlock), toBlock: numberToHex(toBlock) }],
      })) as RpcLog[];
      return raw.map((r) => formatLog(r)).map((l) => ({
        address: l.address,
        blockHash: l.blockHash ?? "",
        blockNumber: l.blockNumber ?? 0n,
        transactionHash: l.transactionHash ?? "",
        logIndex: l.logIndex ?? 0,
        data: l.data,
        topics: l.topics as string[],
        transactionIndex: l.transactionIndex,
        removed: l.removed ?? false,
      }));
    },
    getTransaction: async (hash) => {
      const tx = await client.getTransaction({ hash: hash as `0x${string}` });
      return { hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, nonce: BigInt(tx.nonce), blockHash: tx.blockHash };
    },
    getTransactionReceipt: async (hash) => {
      const r = await client.getTransactionReceipt({ hash: hash as `0x${string}` });
      return { status: r.status, blockNumber: r.blockNumber };
    },
    getBlockWithTransactions: async (n) => {
      const b = await client.getBlock({ blockNumber: n, includeTransactions: true });
      return {
        number: b.number,
        hash: b.hash,
        parentHash: b.parentHash,
        timestamp: b.timestamp,
        transactions: b.transactions.map((tx) => ({
          hash: tx.hash,
          from: tx.from,
          to: tx.to,
          value: tx.value,
          nonce: BigInt(tx.nonce),
          blockHash: tx.blockHash,
        })),
      };
    },
    getBlockReceipts: async (n) => {
      // Raw request: only status/hash/block are needed, so skip viem's full
      // receipt+log formatting.
      const raw = (await client.request({
        method: "eth_getBlockReceipts" as never,
        params: [numberToHex(n)] as never,
      })) as Array<{ transactionHash: string; status: string; blockNumber: string }> | null;
      if (!Array.isArray(raw)) throw new Error(`eth_getBlockReceipts returned no receipts for block ${n}`);
      return raw.map((r) => ({
        transactionHash: r.transactionHash,
        status: r.status === "0x1" ? ("success" as const) : ("reverted" as const),
        blockNumber: BigInt(r.blockNumber),
      }));
    },
  };
}

/** Counting semaphore: at most `max` tasks run at once, FIFO admission. */
export function createLimiter(max: number) {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const queue: Array<() => void> = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) next();
  };
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await fn();
    } finally {
      release();
    }
  };
}

export interface LimitOptions {
  /** Retries of a rate-limited (429 / -32005) call before giving up (default 6). */
  rateLimitRetries?: number;
  /** First cooldown after a rate-limit response; doubles per consecutive hit (default 1000ms). */
  rateLimitBaseMs?: number;
  rateLimitCapMs?: number;
  onRateLimit?: (info: { attempt: number; cooldownMs: number; err: string }) => void;
}

const RATE_LIMIT_RE = /rate limit|too many requests|\b429\b|request limit|throttl/i;
/** Provider responses that mean "your block range / result set is too big". */
export const RANGE_LIMIT_RE =
  /more than \d+ results|range too large|too many results|limit exceeded|exceeds? (the )?max|block range|response size|query timeout/i;

function errChain(err: unknown): Array<{ message?: string; code?: unknown; status?: unknown }> {
  const out: Array<{ message?: string; code?: unknown; status?: unknown }> = [];
  let e: unknown = err;
  for (let i = 0; i < 6 && e; i++) {
    out.push(typeof e === "object" ? (e as never) : { message: String(e) });
    e = typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  }
  return out;
}

/** HTTP 429, explicit throttling text, or JSON-RPC -32005 that is not a
 * result-size complaint (Infura-style "more than 10000 results" is also -32005). */
export function isRateLimitError(err: unknown): boolean {
  const chain = errChain(err);
  const msg = chain.map((e) => String(e.message ?? "")).join(" | ");
  if (chain.some((e) => e.status === 429) || RATE_LIMIT_RE.test(msg)) return true;
  return chain.some((e) => e.code === -32005 || e.code === 429) && !RANGE_LIMIT_RE.test(msg);
}

const LIMITED = Symbol("nexus.limitedSource");

/** Wrap a ChainSource so every RPC shares one concurrency budget — keeps a
 * parallel backfill under free public-RPC rate limits. A rate-limit response
 * pauses ALL calls through this source for an exponentially growing, jittered
 * cooldown (shared, so the window stops hammering the provider) and the call
 * is retried; success resets the cooldown. Other errors pass through.
 * Idempotent: wrapping an already-limited source returns it unchanged, so the
 * live path and backfill share one budget. */
export function limitSource(source: ChainSource, maxConcurrent: number, opts: LimitOptions = {}): ChainSource {
  if ((source as { [LIMITED]?: boolean })[LIMITED]) return source;
  const runSlot = createLimiter(maxConcurrent);
  const retries = Math.max(0, opts.rateLimitRetries ?? 6);
  const baseMs = opts.rateLimitBaseMs ?? 1000;
  const capMs = opts.rateLimitCapMs ?? 30_000;
  let pausedUntil = 0;
  let consecutive = 0;
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const run = async <T>(fn: () => Promise<T>): Promise<T> => {
    for (let attempt = 0; ; attempt++) {
      try {
        const v = await runSlot(async () => {
          const wait = pausedUntil - Date.now();
          if (wait > 0) await sleep(wait);
          return fn();
        });
        consecutive = 0;
        return v;
      } catch (err) {
        if (!isRateLimitError(err) || attempt >= retries) throw err;
        const exp = Math.min(capMs, baseMs * 2 ** consecutive++);
        const cooldownMs = Math.round(exp * (0.8 + Math.random() * 0.4));
        pausedUntil = Math.max(pausedUntil, Date.now() + cooldownMs);
        opts.onRateLimit?.({ attempt: attempt + 1, cooldownMs, err: String(err instanceof Error ? err.message : err).slice(0, 200) });
      }
    }
  };
  const out: ChainSource & { [LIMITED]?: boolean } = {
    getBlockNumber: () => run(() => source.getBlockNumber()),
    getBlock: (n) => run(() => source.getBlock(n)),
    getLogs: (args) => run(() => source.getLogs(args)),
    getTransaction: (h) => run(() => source.getTransaction(h)),
    getTransactionReceipt: (h) => run(() => source.getTransactionReceipt(h)),
  };
  if (source.getBlockWithTransactions) {
    const f = source.getBlockWithTransactions.bind(source);
    out.getBlockWithTransactions = (n) => run(() => f(n));
  }
  if (source.getBlockReceipts) {
    const f = source.getBlockReceipts.bind(source);
    out.getBlockReceipts = (n) => run(() => f(n));
  }
  Object.defineProperty(out, LIMITED, { value: true });
  return out;
}
