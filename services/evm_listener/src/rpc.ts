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

/** Wrap a ChainSource so every RPC shares one concurrency budget — keeps a
 * parallel backfill under free public-RPC rate limits. */
export function limitSource(source: ChainSource, maxConcurrent: number): ChainSource {
  const run = createLimiter(maxConcurrent);
  const out: ChainSource = {
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
  return out;
}
