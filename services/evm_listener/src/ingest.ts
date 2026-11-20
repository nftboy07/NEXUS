// Shared ingest path for logs and blocks: store first, publish only on insert.
// Idempotent by construction — a redelivered log is a store-level duplicate and
// is never published a second time.

import { retry, type Logger } from "@nexus/shared-utils";
import type { EventStore } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import type { ChainSource, SourceBlock, SourceLog } from "./rpc.js";
import { normalizeBlock, normalizeLog } from "./normalize.js";

export interface IngestDeps {
  chainId: number;
  store: EventStore;
  publisher: EventPublisher;
  log: Logger;
  /** Fetch tx + receipt rows for log tx hashes (env INGEST_TRANSACTIONS, default true). */
  ingestTransactions?: boolean;
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

const RPC_RETRY = { baseMs: 250, capMs: 2_000, maxAttempts: 3, jitter: 0.2 };

/**
 * Populate the `transactions` table for the tx hashes carried by a log batch.
 * One HTTP fetch per unique tx hash, behind the shared bounded retry; the
 * upsert itself is idempotent across redeliveries. Call BEFORE advancing the
 * checkpoint so a restart re-attempts any tx we failed to fetch.
 */
export async function ingestTransactions(
  logs: SourceLog[],
  source: ChainSource,
  deps: IngestDeps
): Promise<number> {
  if (deps.ingestTransactions === false) return 0;
  const unique = [...new Set(logs.map((l) => l.transactionHash))].filter(Boolean);
  // Skip hashes already stored — live + reconcile paths deliver the same
  // tx twice, so without this every tx costs 2 RPC calls per delivery.
  const existing = await deps.store.existingTransactions(deps.chainId, unique);
  const missing = unique.filter((h) => !existing.has(h));
  let stored = 0;
  for (const hash of missing) {
    try {
      const [tx, receipt] = await Promise.all([
        retry(() => source.getTransaction(hash), RPC_RETRY),
        retry(() => source.getTransactionReceipt(hash), RPC_RETRY),
      ]);
      await deps.store.upsertTransaction({
        chainId: deps.chainId,
        hash,
        sender: tx.from,
        recipient: tx.to,
        value: tx.value.toString(),
        status: receipt.status,
        blockNumber: receipt.blockNumber,
        nonce: tx.nonce,
        blockHash: tx.blockHash,
      });
      stored++;
    } catch (err) {
      deps.log.warn("transaction fetch failed; left for next backfill", {
        chain_id: deps.chainId,
        tx_hash: hash,
        err: String(err),
      });
    }
  }
  return stored;
}

export type UpsertOutcome = "inserted" | "duplicate";
