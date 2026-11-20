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
    if (this.inflight >= this.maxInflight) return null;
    this.inflight++;
    try {
      const wait = Math.max(0, this.lastCall + this.minIntervalMs - Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastCall = Date.now();
      return await retry(() => this.fetcher.getTransaction(hash), {
        maxAttempts: 3, baseMs: 200, capMs: 2_000,
      });
    } catch (e) {
      this.log.warn("pending tx fetch failed", { hash, err: String(e) });
      return null;
    } finally {
      this.inflight--;
    }
  }
}
