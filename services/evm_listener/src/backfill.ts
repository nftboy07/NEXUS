// HTTP backfill: on startup and after any reconnect, fill (checkpoint, head]
// with eth_getLogs + block fetches in bounded chunks, then resume live subs.

import type { Logger } from "@nexus/shared-utils";
import type { ChainSource, SourceLog } from "./rpc.js";
import type { ParsedLogFilter } from "./subscriptions.js";
import { advanceCheckpoint, readCheckpoint } from "./checkpoint.js";
import { ingestBlock, ingestLogs, type IngestDeps } from "./ingest.js";

export interface BackfillOptions {
  chunkSize?: number; // max blocks per eth_getLogs call, default 2000
}

export interface BackfillResult {
  fromBlock: bigint;
  toBlock: bigint;
  blocksStored: number;
  logsInserted: number;
  logsDuplicate: number;
}

/** Split the half-open range (fromExclusive, to] into [start, end] chunks. */
export function planChunks(fromExclusive: bigint, to: bigint, chunkSize: number): Array<[bigint, bigint]> {
  const chunks: Array<[bigint, bigint]> = [];
  let start = fromExclusive + 1n;
  while (start <= to) {
    const end = start + BigInt(chunkSize) - 1n;
    chunks.push([start, end < to ? end : to]);
    start = end + 1n;
  }
  return chunks;
}

async function fetchChunkLogs(source: ChainSource, filters: ParsedLogFilter[], from: bigint, to: bigint): Promise<SourceLog[]> {
  const out: SourceLog[] = [];
  for (const f of filters) {
    const logs = await source.getLogs({ topics: f.topics, fromBlock: from, toBlock: to });
    out.push(...logs);
  }
  out.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return out;
}

/** Backfill (checkpoint, toBlock] for one chain. Dedup via store upserts. */
export async function backfillRange(
  source: ChainSource,
  filters: ParsedLogFilter[],
  deps: IngestDeps,
  toBlock: bigint,
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  const chunkSize = opts.chunkSize ?? 2000;
  const cp = await readCheckpoint(deps.store, deps.chainId);
  const fromExclusive = cp.lastBlock;
  const result: BackfillResult = {
    fromBlock: fromExclusive,
    toBlock,
    blocksStored: 0,
    logsInserted: 0,
    logsDuplicate: 0,
  };
  if (fromExclusive >= toBlock) return result;

  const chunks = planChunks(fromExclusive, toBlock, chunkSize);
  deps.log.info("backfill start", {
    chain_id: deps.chainId,
    from_block: (fromExclusive + 1n).toString(),
    to_block: toBlock.toString(),
    chunks: chunks.length,
  });

  for (const [start, end] of chunks) {
    const logs = await fetchChunkLogs(source, filters, start, end);
    const stats = await ingestLogs(logs, deps);
    result.logsInserted += stats.inserted;
    result.logsDuplicate += stats.duplicates;

    for (let n = start; n <= end; n++) {
      const block = await source.getBlock(n);
      const r = await ingestBlock(block, deps);
      if (r === "inserted") result.blocksStored++;
      // The block's checkpoint advances only after its events are stored+published.
      await advanceCheckpoint(deps.store, deps.chainId, n, null);
    }

    deps.log.info("backfill chunk complete", {
      chain_id: deps.chainId,
      range: `${start}-${end}`,
      logs_inserted: stats.inserted,
      duplicates: stats.duplicates,
    });
  }

  return result;
}
