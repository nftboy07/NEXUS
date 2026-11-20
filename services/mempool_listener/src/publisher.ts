// Publishing: lifecycle transitions -> nexus:pending; decoded pending txs as
// NexusNormalizedEvent(kind="pending_tx", payload.status) -> nexus:events.

import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { PendingStatus } from "./store.js";
import type { LifecycleEvent } from "./lifecycle.js";

export const PENDING_STREAM = "nexus:pending";
export const EVENTS_STREAM = "nexus:events";

export interface StreamWriter {
  xadd(stream: string, fields: Record<string, string>): Promise<unknown>;
}

export class RedisStreamWriter implements StreamWriter {
  constructor(private client: { xAdd: (key: string, id: string, fields: Record<string, string>) => Promise<unknown> }) {}
  xadd(stream: string, fields: Record<string, string>): Promise<unknown> {
    return this.client.xAdd(stream, "*", fields);
  }
}

export async function publishTransition(w: StreamWriter, e: LifecycleEvent): Promise<void> {
  await w.xadd(PENDING_STREAM, {
    chain_id: String(e.chainId),
    hash: e.hash,
    from: e.from ?? "",
    to: e.to,
    block: e.block?.toString() ?? "",
    replaced_by: e.replacedBy ?? "",
    dedup_key: `${e.chainId}:${e.hash}:${e.to}`,
  });
}

/** A pending_tx normalized event. payload.status marks it as non-final —
 * never describe it as confirmed activity. */
export function pendingTxEvent(chainId: number, tx: {
  hash: string; sender: string | null; to: string | null; value: string;
  method: string | null; decoded: object | null; status: PendingStatus;
  firstSeenBlock: bigint | null; watchlistMatch?: string | null;
}): NexusNormalizedEvent {
  return {
    chain_id: chainId,
    kind: "pending_tx",
    dedup_key: `${chainId}:pending:${tx.hash}`,
    block_number: null,
    block_hash: null,
    tx_hash: tx.hash,
    payload: {
      status: tx.status,          // PENDING signal, not a confirmed fact
      sender: tx.sender,
      to: tx.to,
      value: tx.value,
      method: tx.method,
      decoded: tx.decoded,
      first_seen_block: tx.firstSeenBlock?.toString() ?? null,
      watchlist_match: tx.watchlistMatch ?? null,
      source: "single-provider mempool feed (not a complete global mempool view)",
    },
  };
}
