// Shared ingest path for logs and blocks: store first, publish only on insert.
// Idempotent by construction — a redelivered log is a store-level duplicate and
// is never published a second time.

import type { Logger } from "@nexus/shared-utils";
import type { EventStore } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import type { SourceBlock, SourceLog } from "./rpc.js";
import { normalizeBlock, normalizeLog } from "./normalize.js";

export interface IngestDeps {
  chainId: number;
  store: EventStore;
  publisher: EventPublisher;
  log: Logger;
}

export interface IngestStats {
  inserted: number;
  duplicates: number;
}

export async function ingestLogs(logs: SourceLog[], deps: IngestDeps): Promise<IngestStats> {
  const stats = { inserted: 0, duplicates: 0 };
  for (const l of logs) {
    const result = await deps.store.upsertLog({
      chainId: deps.chainId,
      blockHash: l.blockHash,
      transactionHash: l.transactionHash,
      logIndex: l.logIndex,
      contract: l.address,
      topics: l.topics,
      data: l.data,
      removed: l.removed ?? false,
    });
    if (result === "duplicate") {
      stats.duplicates++;
      deps.log.info("duplicate log suppressed", {
        chain_id: deps.chainId,
        block_hash: l.blockHash,
        tx_hash: l.transactionHash,
        log_index: l.logIndex,
      });
      continue;
    }
    stats.inserted++;
    await deps.publisher.publish(normalizeLog(l, deps.chainId));
  }
  return stats;
}

export async function ingestBlock(block: SourceBlock, deps: IngestDeps): Promise<UpsertOutcome> {
  const result = await deps.store.upsertBlock({
    chainId: deps.chainId,
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
  });
  if (result === "inserted") {
    await deps.publisher.publish(normalizeBlock(block, deps.chainId));
  }
  return result;
}

export type UpsertOutcome = "inserted" | "duplicate";
