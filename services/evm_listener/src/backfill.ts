// HTTP backfill: on startup and after any reconnect, fill (checkpoint, head]
// with eth_getLogs + block fetches in bounded chunks, then resume live subs.

import { retry, type Logger } from "@nexus/shared-utils";
import { limitSource, type ChainSource, type SourceLog } from "./rpc.js";
import type { ParsedLogFilter } from "./subscriptions.js";
import { advanceCheckpoint, readCheckpoint } from "./checkpoint.js";
import { commitPreparedBlock, prepareBlock, type IngestDeps, type PreparedBlock } from "./ingest.js";

export interface BackfillOptions {
  chunkSize?: number; // max blocks per eth_getLogs call, default 2000
  /** BACKFILL_BLOCK_CONCURRENCY: blocks fetched ahead of the in-order
   * commit (header + tx enrichment), default 8. 1 = fully sequential. */
  blockConcurrency?: number;
  /** RPC_MAX_CONCURRENCY: cap on in-flight RPC requests per chain across the
   * whole backfill (getLogs, blocks, txs, receipts), default 8. */
  rpcConcurrency?: number;
}

export const DEFAULT_BLOCK_CONCURRENCY = 8;
export const DEFAULT_RPC_CONCURRENCY = 8;

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

/** Provider responses that mean "your block range / result set is too big". */
const RANGE_LIMIT_RE =
  /more than \d+ results|range too large|too many results|limit exceeded|exceeds? (the )?max|block range|response size|query timeout/i;

/** Throttling is NOT a range problem: splitting on it multiplies requests. */
const RATE_LIMIT_RE = /rate limit|too many requests|\b429\b|-32005|request limit|throttl/i;

export function isRateLimitError(err: unknown): boolean {
  return RATE_LIMIT_RE.test(String(err instanceof Error ? err.message : err));
}

export function isRangeLimitError(err: unknown): boolean {
  const msg = String(err instanceof Error ? err.message : err);
  return !RATE_LIMIT_RE.test(msg) && RANGE_LIMIT_RE.test(msg);
}

const RPC_RETRY = { baseMs: 250, capMs: 2_000, maxAttempts: 3, jitter: 0.2 };

/**
 * Fetch logs for ONE filter (address + topics) over [from, to].
 * Transient errors are retried with the shared bounded backoff; provider
 * range/result-limit errors halve the range recursively down to 1 block.
 */
export async function fetchFilterLogs(
  source: ChainSource,
  filter: ParsedLogFilter,
  from: bigint,
  to: bigint,
  log?: Logger
): Promise<SourceLog[]> {
  const call = () =>
    source.getLogs({ topics: filter.topics, address: filter.address, fromBlock: from, toBlock: to });
  try {
    return await call();
  } catch (err) {
    if (isRangeLimitError(err) && from < to) {
      const mid = from + (to - from) / 2n;
      log?.warn("log range too large, splitting", {
        filter: filter.name,
        from: from.toString(),
        to: to.toString(),
      });
      const [lo, hi] = await Promise.all([
        fetchFilterLogs(source, filter, from, mid, log),
        fetchFilterLogs(source, filter, mid + 1n, to, log),
      ]);
      return [...lo, ...hi];
    }
    // Transient/non-limit error: bounded retry of the same window, then re-check
    // in case the provider reports the limit only under retry pressure.
    try {
      return await retry(call, RPC_RETRY);
    } catch (retryErr) {
      if (isRangeLimitError(retryErr) && from < to) {
        const mid = from + (to - from) / 2n;
        const [lo, hi] = await Promise.all([
          fetchFilterLogs(source, filter, from, mid, log),
          fetchFilterLogs(source, filter, mid + 1n, to, log),
        ]);
        return [...lo, ...hi];
      }
      throw retryErr;
    }
  }
}

/** Shared per-filter fetch used by backfill and per-block reconciliation:
 * one request per filter (own address + topics), issued concurrently (the
 * caller's source decides the RPC budget), results merged and sorted.
 * Overlapping filters may return a log twice; the store upsert dedups. */
export async function fetchLogs(
  source: ChainSource,
  filters: ParsedLogFilter[],
  from: bigint,
  to: bigint,
  log?: Logger
): Promise<SourceLog[]> {
  const perFilter = await Promise.all(filters.map((f) => fetchFilterLogs(source, f, from, to, log)));
  const out = perFilter.flat();
  out.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
  return out;
}

/**
 * Backfill (checkpoint, toBlock] for one chain. Dedup via store upserts.
 *
 * Pipeline per chunk: getLogs for every filter (concurrent) -> up to
 * blockConcurrency blocks prepared ahead (header + tx/receipt fetches; no
 * writes) -> strictly in-order commit: logs stored+published, txs stored,
 * block stored+published, THEN checkpoint = n. A failure at block n leaves
 * the checkpoint at n-1 and nothing past it written, so a restart resumes
 * without gaps; replays are store-level duplicates (never re-published).
 */
export async function backfillRange(
  rawSource: ChainSource,
  filters: ParsedLogFilter[],
  deps: IngestDeps,
  toBlock: bigint,
  opts: BackfillOptions = {}
): Promise<BackfillResult> {
  const chunkSize = opts.chunkSize ?? 2000;
  const window = Math.max(1, Math.floor(opts.blockConcurrency ?? DEFAULT_BLOCK_CONCURRENCY));
  const source = limitSource(rawSource, opts.rpcConcurrency ?? DEFAULT_RPC_CONCURRENCY);
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
    block_concurrency: window,
  });

  for (const [start, end] of chunks) {
    const logs = await fetchLogs(source, filters, start, end, deps.log);
    const byBlock = new Map<bigint, SourceLog[]>();
    for (const l of logs) {
      const list = byBlock.get(l.blockNumber);
      if (list) list.push(l);
      else byBlock.set(l.blockNumber, [l]);
    }
    const chunkStats = { inserted: 0, duplicates: 0 };

    // Prefetch window: prepare(n..n+window-1) run concurrently; commits stay
    // block-at-a-time in order so the checkpoint advances steadily through a
    // large chunk and a restart resumes mid-chunk.
    const inflight = new Map<bigint, Promise<PreparedBlock>>();
    let nextPrepare = start;
    const fill = (n: bigint) => {
      while (nextPrepare <= end && nextPrepare < n + BigInt(window)) {
        const p = prepareBlock(nextPrepare, byBlock.get(nextPrepare) ?? [], source, deps);
        p.catch(() => {}); // surfaced when awaited in order; avoid unhandled rejection
        inflight.set(nextPrepare, p);
        nextPrepare++;
      }
    };
    for (let n = start; n <= end; n++) {
      fill(n);
      const prepared = await inflight.get(n)!;
      inflight.delete(n);
      const { stats, block } = await commitPreparedBlock(prepared, deps);
      chunkStats.inserted += stats.inserted;
      chunkStats.duplicates += stats.duplicates;
      if (block === "inserted") result.blocksStored++;
      // The block's checkpoint advances only after its events are stored+published.
      await advanceCheckpoint(deps.store, deps.chainId, n, null);
    }
    result.logsInserted += chunkStats.inserted;
    result.logsDuplicate += chunkStats.duplicates;

    deps.log.info("backfill chunk complete", {
      chain_id: deps.chainId,
      range: `${start}-${end}`,
      logs_inserted: chunkStats.inserted,
      duplicates: chunkStats.duplicates,
    });
  }

  return result;
}
