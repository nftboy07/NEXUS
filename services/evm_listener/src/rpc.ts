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
  };
}
