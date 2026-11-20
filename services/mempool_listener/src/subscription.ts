// Pending-hash subscription: WS eth_subscribe newPendingTransactions ->
// bounded-concurrency eth_getTransactionByHash fetcher (per-provider rate
// limit + max in-flight). Reconnect uses the shared bounded backoff.

import type { Logger } from "@nexus/shared-utils";
import { retry } from "@nexus/shared-utils";

export interface TxFetcher {
  getTransaction(hash: string): Promise<{
    hash: string; from: string; to: string | null; input: string; value: bigint; nonce: bigint;
  } | null>;
}

export class FetchQueue {
  private inflight = 0;
  private lastCall = 0;

  constructor(
    private fetcher: TxFetcher,
    private maxInflight: number,
    private minIntervalMs: number,
    private log: Logger,
  ) {}

  /** Bounded + rate-limited fetch; drops when saturated (tx stays DETECTED). */
  async fetch(hash: string) {
    return this.run(() => this.fetcher.getTransaction(hash), hash);
  }

  /** Generic bounded + rate-limited + retried call (fetch or inclusion probe). */
  async run<T>(fn: () => Promise<T>, tag = "rpc"): Promise<T | null> {
    if (this.inflight >= this.maxInflight) return null;
    this.inflight++;
    try {
      const wait = Math.max(0, this.lastCall + this.minIntervalMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      return await retry(fn, { maxAttempts: 3, baseMs: 200, capMs: 2_000 });
    } catch (e) {
      this.log.warn("rpc call failed", { tag, err: String(e) });
      return null;
    } finally {
      this.inflight--;
    }
  }
}

/** Inclusion evidence available only over RPC (receipts, account nonce).
 * Engine 1's transactions table only has log-emitting txs, so pending rows
 * need this fallback for inclusion/replacement resolution. */
export interface InclusionProbe {
  /** eth_getTransactionReceipt; null when the tx isn't mined. */
  getReceipt(chainId: number, hash: string): Promise<{ blockNumber: bigint; blockHash: string } | null>;
  /** eth_getTransactionCount at "latest" — consumed nonce count for sender. */
  getNonce(chainId: number, sender: string): Promise<bigint | null>;
}

export class RpcInclusionProbe implements InclusionProbe {
  constructor(private queue: FetchQueue, private client: {
    getTransactionReceipt(args: { hash: `0x${string}` }): Promise<{ blockNumber: bigint; blockHash: string }>;
    getTransactionCount(args: { address: `0x${string}`; blockTag: "latest" }): Promise<number>;
  }) {}

  async getReceipt(chainId: number, hash: string) {
    const r = await this.queue.run(
      async () => {
        try {
          return await this.client.getTransactionReceipt({ hash: hash as `0x${string}` });
        } catch {
          return null; // not mined / unknown hash
        }
      },
      `receipt:${chainId}`,
    );
    if (!r) return null;
    return { blockNumber: r.blockNumber, blockHash: r.blockHash };
  }

  async getNonce(chainId: number, sender: string) {
    return this.queue.run(
      async () => BigInt(await this.client.getTransactionCount({ address: sender as `0x${string}`, blockTag: "latest" })),
      `nonce:${chainId}`,
    );
  }
}
