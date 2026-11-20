// Provider capability probe: does eth_subscribe newPendingTransactions
// actually deliver? Subscribe once, await the first notification or a short
// timeout. Unsupported -> the chain's mempool feed is DISABLED with an
// explicit log line and a provider_health row. Never fall back to polling.

import type { Logger } from "@nexus/shared-utils";

/** Test seam: (onHash, onError) -> unsubscribe. */
export type PendingSubscribe = (onHash: (hash: string) => void, onError: (e: unknown) => void) => () => void;

export interface CapabilityResult {
  supported: boolean;
  reason: string;
}

export async function probePendingSupport(
  subscribe: PendingSubscribe,
  timeoutMs = 15_000,
): Promise<CapabilityResult> {
  return new Promise((resolve) => {
    let unsub: (() => void) | null = null;
    const done = (r: CapabilityResult) => {
      clearTimeout(timer);
      try { unsub?.(); } catch { /* best effort */ }
      resolve(r);
    };
    const timer = setTimeout(() => {
      done({ supported: true, reason: "subscribed; no hashes observed within timeout (quiet mempool is still supported)" });
    }, timeoutMs);
    try {
      unsub = subscribe(
        () => done({ supported: true, reason: "pending hash observed" }),
        (e) => done({ supported: false, reason: `subscription error: ${String(e)}` }),
      );
    } catch (e) {
      done({ supported: false, reason: `subscribe threw: ${String(e)}` });
    }
  });
}

export function reportCapability(
  supported: boolean,
  reason: string,
  chainId: number,
  log: Logger,
): void {
  if (supported) {
    log.info("mempool feed enabled", { chain_id: chainId, reason });
  } else {
    log.warn("mempool feed disabled for chain: provider does not support pending subscriptions", {
      chain_id: chainId, reason,
    });
  }
}
