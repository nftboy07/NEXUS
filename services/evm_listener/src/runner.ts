// Per-chain pipeline: startup backfill -> reorg-aware head handling ->
// live log ingest -> heartbeat/failover supervision. One isolated instance
// per chain; a failure here must not stop other chains.

import type { Logger } from "@nexus/shared-utils";
import type { ChainConfig } from "./config.js";
import type { ChainClients, ChainSource } from "./rpc.js";
import { limitSource, viemChainSource } from "./rpc.js";
import type { EventStore } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import type { ParsedLogFilter } from "./subscriptions.js";
import { heartbeatStaleMs, watchBlocks, watchLogs, type Subscription } from "./subscriptions.js";
import { backfillRange, fetchLogs, type BackfillOptions } from "./backfill.js";
import { resolveReorg } from "./reorg.js";
import { filterFingerprint } from "./scopedFilters.js";
import { advanceCheckpoint, readCheckpoint } from "./checkpoint.js";
import { ingestBlock, ingestLogs, ingestTransactions, type TxEnrichMode } from "./ingest.js";
import { HealthReporter } from "./health.js";
import { recoverProvider, type ProviderState } from "./failover.js";

export interface RunnerDeps {
  chain: ChainConfig;
  filters: ParsedLogFilter[];
  store: EventStore;
  publisher: EventPublisher;
  log: Logger;
  clients: { primary: ChainClients; secondary?: ChainClients };
  heartbeatTimeoutMs?: number;
  healthIntervalMs?: number;
  chunkSize?: number;
  /** Backfill pipeline knobs (BACKFILL_BLOCK_CONCURRENCY, RPC_MAX_CONCURRENCY). */
  blockConcurrency?: number;
  rpcConcurrency?: number;
  /** Cold-start depth when no checkpoint row exists (START_BACKFILL_BLOCKS, default 50). */
  startBackfillBlocks?: number;
  /** Fetch tx+receipt rows for log tx hashes (INGEST_TRANSACTIONS, default true). */
  ingestTransactions?: boolean;
  txFetchConcurrency?: number;
  txEnrichMode?: TxEnrichMode;
  blockEnrichThreshold?: number;
  /** Scoped-filter refresh: rebuild filters from watchlists/pools every
   * intervalSeconds; resubscribes + backfills from checkpoint on change.
   * Absent = static filters (LOG_FILTER_MODE=full behaviour). */
  filterRefresh?: { build: () => Promise<ParsedLogFilter[]>; intervalSeconds: number };
}

const DEFAULT_HEARTBEAT_MS = 60_000;

export class ChainRunner {
  private subs: Subscription[] = [];
  private health: HealthReporter;
  private stopped = false;
  private processing: Promise<void> = Promise.resolve();
  private activeFilters: ParsedLogFilter[];
  readonly state: ProviderState;
  readonly deps: RunnerDeps;
  private log: Logger;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
    this.activeFilters = deps.filters;
    this.log = deps.log.child({ chain: deps.chain.name, chain_id: deps.chain.id });
    this.state = { active: deps.clients.primary, outages: 0, reconnects: 0 };
    this.health = new HealthReporter({
      providerName: `${deps.chain.name}-primary`,
      chainId: deps.chain.id,
      store: deps.store,
      source: () => this.source(),
      log: this.log,
      intervalMs: deps.healthIntervalMs,
    });
  }

  private limited?: { http: unknown; source: ChainSource };

  /** One rate-limited source per active provider, shared by live + backfill. */
  private source(): ChainSource {
    const http = this.state.active.http;
    if (this.limited?.http !== http) {
      this.limited = {
        http,
        source: limitSource(viemChainSource(http), this.deps.rpcConcurrency ?? 8, {
          onRateLimit: (i) => this.log.warn("rpc rate limited; backing off", i),
        }),
      };
    }
    return this.limited.source;
  }

  private ingest() {
    return {
      chainId: this.deps.chain.id,
      store: this.deps.store,
      publisher: this.deps.publisher,
      log: this.log,
      ingestTransactions: this.deps.ingestTransactions,
      txFetchConcurrency: this.deps.txFetchConcurrency,
      txEnrichMode: this.deps.txEnrichMode,
      blockEnrichThreshold: this.deps.blockEnrichThreshold,
    };
  }

  private backfillOpts(): BackfillOptions {
    return {
      chunkSize: this.deps.chunkSize,
      blockConcurrency: this.deps.blockConcurrency,
      rpcConcurrency: this.deps.rpcConcurrency,
    };
  }

  /** Serialize block/log work so reorg + backfill can't interleave. */
  private enqueue(fn: () => Promise<void>): void {
    this.processing = this.processing.then(fn).catch((err) => {
      this.log.error("pipeline error", { err: String(err) });
    });
  }

  async start(): Promise<void> {
    const head = await this.source().getBlockNumber();
    // Cold start: no checkpoint row -> seed at head - START_BACKFILL_BLOCKS
    // (or the chain's chains.json `start_block`) so we never scan from genesis.
    const existing = await this.deps.store.getCheckpoint(this.deps.chain.id);
    if (existing === null) {
      const depth = this.deps.startBackfillBlocks ?? 50;
      const seed = this.deps.chain.startBlock ?? (head - BigInt(depth) > 0n ? head - BigInt(depth) : 0n);
      await this.deps.store.setCheckpoint(this.deps.chain.id, seed, null);
      this.log.info("cold start: checkpoint seeded", { head: head.toString(), seed: seed.toString() });
    }
    if (this.deps.filterRefresh) {
      this.activeFilters = await this.deps.filterRefresh.build();
      this.log.info("scoped log filters built", { count: this.activeFilters.length });
    }
    const cp = await readCheckpoint(this.deps.store, this.deps.chain.id);
    if (head > cp.lastBlock) {
      await backfillRange(this.source(), this.activeFilters, this.ingest(), head, this.backfillOpts());
    }
    this.subscribe();
    this.health.start();
    this.startHeartbeatWatch();
    this.startFilterRefresh();
  }

  private subscribe(): void {
    this.unsubscribe();
    const cb = {
      onBlock: (b: { number: bigint; hash: string; parentHash: string; timestamp: bigint }) =>
        this.enqueue(() => this.handleBlock(b)),
      onLogs: (logs: Parameters<typeof ingestLogs>[0]) => this.enqueue(() => this.handleLogs(logs)),
      onError: (err: unknown, name: string) => {
        this.log.error("subscription error", { subscription: name, err: String(err) });
        this.enqueue(() => this.recover());
      },
    };
    this.subs = [watchBlocks(this.state.active.ws, cb), ...watchLogs(this.state.active.ws, this.activeFilters, cb)];
    this.log.info("subscriptions active", { provider: this.state.active.role, subs: this.subs.map((s) => s.name) });
  }

  private unsubscribe(): void {
    for (const s of this.subs) s.unwatch();
    this.subs = [];
  }

  private async handleBlock(block: { number: bigint; hash: string; parentHash: string; timestamp: bigint }) {
    const chain = this.deps.chain;
    const reorg = await resolveReorg(block, this.source(), this.deps.store, chain.id, chain.confirmations, this.log,
      async (orphaned) => {
        // Publish block_removed exactly once per orphaned block: the
        // removed_blocks marker makes replays idempotent.
        if (await this.deps.store.insertRemovedBlock(chain.id, orphaned.hash)) {
          await this.deps.publisher.publish({
            chain_id: chain.id,
            kind: "block_removed",
            dedup_key: `${chain.id}:${orphaned.hash}:removed`,
            block_number: Number(orphaned.number),
            block_hash: orphaned.hash,
            tx_hash: null,
            payload: { block_hash: orphaned.hash, block_number: Number(orphaned.number) },
          });
        }
      });
    if (reorg.reorged && reorg.ancestor !== undefined) {
      // Reprocess the canonical range from the common ancestor forward.
      await backfillRange(this.source(), this.activeFilters, this.ingest(), block.number, this.backfillOpts());
      return;
    }
    // Gap guard: watchBlocks can jump heads (e.g. 100 -> 103). If the head
    // is more than one block past the checkpoint, backfill the missing range
    // instead of single-block processing.
    const cp = await readCheckpoint(this.deps.store, chain.id);
    if (block.number > cp.lastBlock + 1n) {
      this.log.info("head gap detected, backfilling", {
        checkpoint: cp.lastBlock.toString(),
        head: block.number.toString(),
      });
      await backfillRange(this.source(), this.activeFilters, this.ingest(), block.number, this.backfillOpts());
      return;
    }
    await ingestBlock(block, this.ingest());
    // Reconcile this block's logs via HTTP — dedup makes it free when the
    // live subscription already delivered them. Checkpoint only advances
    // after the block's events are stored AND published.
    const logs = await fetchLogs(this.source(), this.activeFilters, block.number, block.number, this.log);
    await ingestLogs(logs, this.ingest());
    await ingestTransactions(logs, this.source(), this.ingest());
    await advanceCheckpoint(this.deps.store, chain.id, block.number, null);
    this.log.debug("block processed", { block: block.number.toString(), lag: 0 });
  }

  private async handleLogs(logs: Parameters<typeof ingestLogs>[0]): Promise<void> {
    await ingestLogs(logs, this.ingest());
    await ingestTransactions(logs, this.source(), this.ingest());
  }

  private startHeartbeatWatch(): void {
    const timeout = this.deps.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_MS;
    const timer = setInterval(() => {
      for (const s of this.subs) {
        if (heartbeatStaleMs(s) > timeout && !this.stopped) {
          this.log.warn("subscription heartbeat timeout", { subscription: s.name, stale_ms: heartbeatStaleMs(s) });
          this.enqueue(() => this.recover());
          return;
        }
      }
    }, Math.max(1000, Math.floor(timeout / 2)));
    timer.unref?.();
    this.subs.push({ name: "__heartbeat_timer__", startedAt: 0, lastMessageAt: 0, unwatch: () => clearInterval(timer) });
  }

  private async recover(): Promise<void> {
    const next = await recoverProvider(
      this.state,
      { primary: true, secondary: Boolean(this.deps.clients.secondary) },
      {
        chainId: this.deps.chain.id,
        chainName: this.deps.chain.name,
        store: this.deps.store,
        log: this.log,
        reconnect: async (role) =>
          role === "primary" ? this.deps.clients.primary : (this.deps.clients.secondary ?? this.deps.clients.primary),
      }
    );
    this.state.active = next.active;
    this.state.outages = next.outages;
    this.state.reconnects = next.reconnects;
    this.health.counters.outages = next.outages;
    this.health.counters.reconnects = next.reconnects;
    // Never assume reconnecting recovers missed events: backfill from checkpoint.
    const head = await this.source().getBlockNumber();
    await backfillRange(this.source(), this.activeFilters, this.ingest(), head, this.backfillOpts());
    this.subscribe();
  }

  /** Scoped-filter refresh: when the derived filter set changes
   * (watchlist/pool rows added), resubscribe WS watchers and backfill
   * from the checkpoint — new addresses are covered from the checkpoint
   * on; history before they were added is intentionally NOT backfilled. */
  private startFilterRefresh(): void {
    const fr = this.deps.filterRefresh;
    if (!fr) return;
    const timer = setInterval(() => {
      this.enqueue(async () => {
        try {
          const next = await fr.build();
          if (filterFingerprint(next) === filterFingerprint(this.activeFilters)) return;
          this.log.info("log filters changed; resubscribing + backfilling from checkpoint", {
            before: this.activeFilters.length, after: next.length,
          });
          this.activeFilters = next;
          this.subscribe();
          const head = await this.source().getBlockNumber();
          await backfillRange(this.source(), this.activeFilters, this.ingest(), head, this.backfillOpts());
        } catch (err) {
          this.log.error("filter refresh failed", { err: String(err) });
        }
      });
    }, fr.intervalSeconds * 1000);
    timer.unref?.();
    this.subs.push({ name: "__filter_refresh_timer__", startedAt: 0, lastMessageAt: 0, unwatch: () => clearInterval(timer) });
  }

  /** Test hook: resolves when all enqueued block/log work has drained. */
  async drain(): Promise<void> {
    await this.processing;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.health.stop();
    await this.processing;
  }
}

export interface RunChainsOptions {
  /** Retry a chain whose start failed after this delay (doubling, capped at
   * 5 min) until it starts; it is appended to the returned array then. */
  retryDelayMs?: number;
  /** Return true to cancel pending retries (shutdown). */
  isStopped?: () => boolean;
}

/** Run one runner per chain; one chain failing must not stop the others. */
export async function runChains(
  deps: RunnerDeps[],
  onChainError?: (chain: ChainConfig, err: unknown) => void,
  opts: RunChainsOptions = {}
): Promise<ChainRunner[]> {
  const runners: ChainRunner[] = [];
  const start = async (d: RunnerDeps) => {
    const runner = new ChainRunner(d);
    try {
      await runner.start();
    } catch (err) {
      await runner.stop().catch(() => {});
      throw err;
    }
    return runner;
  };
  const retryLater = (d: RunnerDeps, delayMs: number) => {
    const t = setTimeout(async () => {
      if (opts.isStopped?.()) return;
      try {
        runners.push(await start(d));
        d.log.info("chain started after retry", { chain: d.chain.name });
      } catch (err) {
        onChainError?.(d.chain, err);
        retryLater(d, Math.min(delayMs * 2, 300_000));
      }
    }, delayMs);
    t.unref?.();
  };
  // Report each failure as it happens, not after every other chain's
  // (possibly long) backfill has finished.
  await Promise.all(
    deps.map(async (d) => {
      try {
        runners.push(await start(d));
      } catch (err) {
        onChainError?.(d.chain, err);
        if (opts.retryDelayMs) retryLater(d, opts.retryDelayMs);
      }
    })
  );
  return runners;
}
