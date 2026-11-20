// Reorg handling: store block + parent hashes; within each chain's
// `confirmations` depth verify parent linkage on each new head. On mismatch,
// walk back to the common ancestor, mark affected logs removed = TRUE, and
// rewind the checkpoint so backfill reprocesses the canonical range.

import type { Logger } from "@nexus/shared-utils";
import type { ChainSource, SourceBlock } from "./rpc.js";
import type { EventStore } from "./store.js";
import { rewindCheckpoint } from "./checkpoint.js";

export interface ReorgResult {
  reorged: boolean;
  /** Canonical ancestor number the checkpoint rewound to (inclusive). */
  ancestor?: bigint;
  /** Block numbers whose stored hashes were found non-canonical. */
  orphaned: bigint[];
  /** True when the fork is deeper than the chain's confirmations depth. */
  beyondConfirmations: boolean;
}

/**
 * Check a new head against stored block hashes. Returns { reorged: false }
 * when the head's parent matches the stored block at height-1 (or no stored
 * block exists yet). Otherwise walks back over the canonical chain (via
 * `source`) until the stored hash matches, marking orphaned logs removed.
 */
export async function resolveReorg(
  head: SourceBlock,
  source: ChainSource,
  store: EventStore,
  chainId: number,
  confirmations: number,
  log: Logger
): Promise<ReorgResult> {
  const parentNumber = head.number - 1n;
  if (parentNumber < 0n) return { reorged: false, orphaned: [], beyondConfirmations: false };

  const storedParents = await store.getBlockByNumber(chainId, parentNumber);
  const parentMatches =
    storedParents.length === 0 || storedParents.some((b) => b.hash.toLowerCase() === head.parentHash.toLowerCase());
  if (parentMatches) return { reorged: false, orphaned: [], beyondConfirmations: false };

  // Parent hash mismatch: walk back until stored hash == canonical hash.
  const orphaned: bigint[] = [];
  let n = parentNumber;
  let depth = 0;
  let beyond = false;
  let ancestor: bigint | undefined;

  while (n >= 0n) {
    depth++;
    if (depth > confirmations) {
      beyond = true;
      log.error("reorg deeper than confirmations depth", {
        chain_id: chainId,
        depth,
        confirmations,
        block: n.toString(),
      });
      break;
    }
    const canonical = await source.getBlock(n);
    const stored = await store.getBlockByNumber(chainId, n);
    if (stored.some((b) => b.hash.toLowerCase() === canonical.hash.toLowerCase())) {
      ancestor = n;
      break;
    }
    for (const b of stored) {
      const removedCount = await store.markLogsRemoved(chainId, b.hash);
      log.warn("marked logs removed for orphaned block", {
        chain_id: chainId,
        block_number: b.number.toString(),
        block_hash: b.hash,
        logs_removed: removedCount,
      });
    }
    orphaned.push(n);
    n = n - 1n;
  }

  if (ancestor !== undefined) {
    await rewindCheckpoint(store, chainId, ancestor);
    log.warn("checkpoint rewound after reorg", {
      chain_id: chainId,
      ancestor: ancestor.toString(),
      orphaned: orphaned.map((o) => o.toString()),
    });
  }

  return { reorged: true, ancestor, orphaned, beyondConfirmations: beyond };
}
