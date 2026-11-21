// Shared ingest path for logs and blocks: store first, publish only on insert.
// Idempotent by construction — a redelivered log is a store-level duplicate and
// is never published a second time.

import { retry, type Logger } from "@nexus/shared-utils";
import type { EventStore, StoredLog, StoredTransaction } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import type { ChainSource, SourceBlock, SourceLog, SourceReceipt, SourceTransaction } from "./rpc.js";
import { normalizeBlock, normalizeLog } from "./normalize.js";

export type TxEnrichMode = "auto" | "tx" | "block";

export interface IngestDeps {
  chainId: number;
  store: EventStore;
  publisher: EventPublisher;
  log: Logger;
  /** Fetch tx + receipt rows for log tx hashes (env INGEST_TRANSACTIONS, default true). */
  ingestTransactions?: boolean;
  /** Parallel tx+receipt fetches per block (TX_FETCH_CONCURRENCY, default 8). */
  txFetchConcurrency?: number;
  /** TX_ENRICH_MODE: "tx" = getTransaction+getTransactionReceipt per hash;
   * "block" = one full-tx getBlock + one eth_getBlockReceipts per block;
   * "auto" (default) = "block" when a block has >= blockEnrichThreshold
   * missing txs, else "tx". Block mode falls back to per-tx on error. */
  txEnrichMode?: TxEnrichMode;
  /** BLOCK_ENRICH_THRESHOLD (default 4). */
  blockEnrichThreshold?: number;
}

export interface IngestStats {
  inserted: number;
  duplicates: number;
}

export async function ingestLogs(logs: SourceLog[], deps: IngestDeps): Promise<IngestStats> {
  const stats = { inserted: 0, duplicates: 0 };
  if (logs.length === 0) return stats;
  const rows: StoredLog[] = logs.map((l) => ({
    chainId: deps.chainId,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    logIndex: l.logIndex,
    contract: l.address,
    topics: l.topics,
    data: l.data,
    removed: l.removed ?? false,
  }));
  let results: UpsertOutcome[];
  if (deps.store.upsertLogs) {
    results = await deps.store.upsertLogs(rows);
  } else {
    results = [];
    for (const r of rows) results.push(await deps.store.upsertLog(r));
  }
  const toPublish: SourceLog[] = [];
  logs.forEach((l, i) => {
    if (results[i] === "duplicate") {
      stats.duplicates++;
      deps.log.debug("duplicate log suppressed", {
        chain_id: deps.chainId,
        block_hash: l.blockHash,
        tx_hash: l.transactionHash,
        log_index: l.logIndex,
      });
      return;
    }
    stats.inserted++;
    toPublish.push(l);
  });
  // Issued in input order on one connection (node-redis pipelines them), so
  // stream order matches log order; any failure rejects before the caller
  // advances the checkpoint.
  await Promise.all(toPublish.map((l) => deps.publisher.publish(normalizeLog(l, deps.chainId))));
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

export const RPC_RETRY = { baseMs: 250, capMs: 2_000, maxAttempts: 3, jitter: 0.2 };

/** Unique log tx hashes that have no transactions row yet. */
async function missingTxHashes(logs: SourceLog[], deps: IngestDeps): Promise<string[]> {
  if (deps.ingestTransactions === false) return [];
  const unique = [...new Set(logs.map((l) => l.transactionHash))].filter(Boolean);
  if (unique.length === 0) return [];
  // Skip hashes already stored — live + reconcile paths deliver the same
  // tx twice, so without this every tx costs 2 RPC calls per delivery.
  const existing = await deps.store.existingTransactions(deps.chainId, unique);
  return unique.filter((h) => !existing.has(h));
}

/** One getTransaction + getTransactionReceipt per hash, bounded concurrency.
 * A failed hash is logged and skipped (left for a later backfill). */
async function fetchTxRowsPerTx(hashes: string[], source: ChainSource, deps: IngestDeps): Promise<StoredTransaction[]> {
  const rows: Array<StoredTransaction | null> = new Array(hashes.length).fill(null);
  const concurrency = Math.max(1, deps.txFetchConcurrency ?? 8);
  let next = 0;
  const worker = async () => {
    while (next < hashes.length) {
      const i = next++;
      rows[i] = await fetchTxRow(hashes[i], source, deps);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, hashes.length) }, worker));
  return rows.filter((r): r is StoredTransaction => r !== null);
}

async function fetchTxRow(hash: string, source: ChainSource, deps: IngestDeps): Promise<StoredTransaction | null> {
  try {
    const [tx, receipt] = await Promise.all([
      retry(() => source.getTransaction(hash), RPC_RETRY),
      retry(() => source.getTransactionReceipt(hash), RPC_RETRY),
    ]);
    return {
      chainId: deps.chainId,
      hash,
      sender: tx.from,
      recipient: tx.to,
      value: tx.value.toString(),
      status: receipt.status,
      blockNumber: receipt.blockNumber,
      nonce: tx.nonce,
      blockHash: tx.blockHash,
    };
  } catch (err) {
    deps.log.warn("transaction fetch failed; left for next backfill", {
      chain_id: deps.chainId,
      tx_hash: hash,
      err: String(err),
    });
    return null;
  }
}

export interface PreparedBlock {
  block: SourceBlock;
  logs: SourceLog[];
  txRows: StoredTransaction[];
}

function useBlockEnrichment(missing: number, source: ChainSource, deps: IngestDeps): boolean {
  if (missing === 0 || !source.getBlockWithTransactions) return false;
  const mode = deps.txEnrichMode ?? "auto";
  if (mode === "tx") return false;
  if (mode === "block") return true;
  return missing >= Math.max(1, deps.blockEnrichThreshold ?? 4);
}

/**
 * Fetch everything block `n` needs (header + tx/receipt rows for its log tx
 * hashes) WITHOUT writing anything. Side-effect free so backfill can run it
 * ahead of the in-order commit; only commitPreparedBlock writes.
 */
export async function prepareBlock(
  n: bigint,
  logs: SourceLog[],
  source: ChainSource,
  deps: IngestDeps
): Promise<PreparedBlock> {
  const missing = await missingTxHashes(logs, deps);
  if (useBlockEnrichment(missing.length, source, deps)) {
    try {
      return { ...(await prepareViaBlock(n, missing, source, deps)), logs };
    } catch (err) {
      deps.log.warn("block-level tx enrichment failed; falling back to per-tx", {
        chain_id: deps.chainId,
        block: n.toString(),
        err: String(err),
      });
    }
  }
  const [block, txRows] = await Promise.all([
    retry(() => source.getBlock(n), RPC_RETRY),
    fetchTxRowsPerTx(missing, source, deps),
  ]);
  return { block, logs, txRows };
}

async function prepareViaBlock(
  n: bigint,
  missing: string[],
  source: ChainSource,
  deps: IngestDeps
): Promise<{ block: SourceBlock; txRows: StoredTransaction[] }> {
  const full = await retry(() => source.getBlockWithTransactions!(n), RPC_RETRY);
  const txByHash = new Map(full.transactions.map((t) => [t.hash.toLowerCase(), t]));
  let statusByHash: Map<string, SourceReceipt> | null = null;
  if (source.getBlockReceipts) {
    try {
      const receipts = await retry(() => source.getBlockReceipts!(n), RPC_RETRY);
      statusByHash = new Map(receipts.map((r) => [r.transactionHash.toLowerCase(), r]));
    } catch (err) {
      deps.log.debug("eth_getBlockReceipts unavailable; per-tx receipts", {
        chain_id: deps.chainId,
        block: n.toString(),
        err: String(err),
      });
    }
  }
  const rows: StoredTransaction[] = [];
  const fallback: string[] = [];
  const receiptOnly: string[] = [];
  for (const h of missing) {
    const tx = txByHash.get(h.toLowerCase());
    if (!tx) {
      fallback.push(h);
      continue;
    }
    const r = statusByHash?.get(h.toLowerCase());
    if (!r) {
      receiptOnly.push(h);
      continue;
    }
    rows.push(txRow(deps.chainId, h, tx, r));
  }
  // Receipts without a block-receipts call: fetch just the receipt per tx.
  const concurrency = Math.max(1, deps.txFetchConcurrency ?? 8);
  let next = 0;
  const receiptWorker = async () => {
    while (next < receiptOnly.length) {
      const h = receiptOnly[next++];
      try {
        const r = await retry(() => source.getTransactionReceipt(h), RPC_RETRY);
        rows.push(txRow(deps.chainId, h, txByHash.get(h.toLowerCase())!, r));
      } catch (err) {
        deps.log.warn("transaction fetch failed; left for next backfill", {
          chain_id: deps.chainId,
          tx_hash: h,
          err: String(err),
        });
      }
    }
  };
  const [, extra] = await Promise.all([
    Promise.all(Array.from({ length: Math.min(concurrency, receiptOnly.length) }, receiptWorker)),
    fetchTxRowsPerTx(fallback, source, deps),
  ]);
  rows.push(...extra);
  const block: SourceBlock = { number: full.number, hash: full.hash, parentHash: full.parentHash, timestamp: full.timestamp };
  return { block, txRows: rows };
}

function txRow(chainId: number, hash: string, tx: SourceTransaction, r: SourceReceipt): StoredTransaction {
  return {
    chainId,
    hash,
    sender: tx.from,
    recipient: tx.to,
    value: tx.value.toString(),
    status: r.status,
    blockNumber: r.blockNumber,
    nonce: tx.nonce,
    blockHash: tx.blockHash,
  };
}

export async function storeTransactions(rows: StoredTransaction[], deps: IngestDeps): Promise<void> {
  if (rows.length === 0) return;
  if (deps.store.upsertTransactions) {
    await deps.store.upsertTransactions(rows);
    return;
  }
  for (const r of rows) await deps.store.upsertTransaction(r);
}

/** In-order write of a prepared block: logs (+publish), txs, block (+publish).
 * The caller advances the checkpoint only after this resolves. */
export async function commitPreparedBlock(p: PreparedBlock, deps: IngestDeps): Promise<{ stats: IngestStats; block: UpsertOutcome }> {
  const stats = await ingestLogs(p.logs, deps);
  await storeTransactions(p.txRows, deps);
  const block = await ingestBlock(p.block, deps);
  return { stats, block };
}

/**
 * Populate the `transactions` table for the tx hashes carried by a log batch.
 * The upsert itself is idempotent across redeliveries. Call BEFORE advancing
 * the checkpoint so a restart re-attempts any tx we failed to fetch.
 */
export async function ingestTransactions(
  logs: SourceLog[],
  source: ChainSource,
  deps: IngestDeps
): Promise<number> {
  const missing = await missingTxHashes(logs, deps);
  if (missing.length === 0) return 0;
  const rows = await fetchTxRowsPerTx(missing, source, deps);
  await storeTransactions(rows, deps);
  return rows.length;
}

export type UpsertOutcome = "inserted" | "duplicate";
