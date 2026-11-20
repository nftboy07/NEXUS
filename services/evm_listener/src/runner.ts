// Per-chain pipeline: startup backfill -> reorg-aware head handling ->
// live log ingest -> heartbeat/failover supervision. One isolated instance
// per chain; a failure here must not stop other chains.

import type { Logger } from "@nexus/shared-utils";
import type { ChainConfig } from "./config.js";
import type { ChainClients, ChainSource } from "./rpc.js";
import { viemChainSource } from "./rpc.js";
import type { EventStore } from "./store.js";
import type { EventPublisher } from "./publisher.js";
import type { ParsedLogFilter } from "./subscriptions.js";
import { heartbeatStaleMs, watchBlocks, watchLogs, type Subscription } from "./subscriptions.js";
import { backfillRange } from "./backfill.js";
import { resolveReorg } from "./reorg.js";
import { advanceCheckpoint, readCheckpoint } from "./checkpoint.js";
import { ingestBlock, ingestLogs } from "./ingest.js";
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
}

const DEFAULT_HEARTBEAT_MS = 60_000;

export class ChainRunner {
  private subs: Subscription[] = [];
  private health: HealthReporter;
  private stopped = false;
  private processing: Promise<void> = Promise.resolve();
  readonly state: ProviderState;
  readonly deps: RunnerDeps;
  private log: Logger;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
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

  private source(): ChainSource {
    return viemChainSource(this.state.active.http);
  }

  private ingest() {
    return { chainId: this.deps.chain.id, store: this.deps.store, publisher: this.deps.publisher, log: this.log };
  }

  /** Serialize block/log work so reorg + backfill can't interleave. */
  private enqueue(fn: () => Promise<void>): void {
    this.processing = this.processing.then(fn).catch((err) => {
      this.log.error("pipeline error", { err: String(err) });
    });
  }

  async start(): Promise<void> {
    const head = await this.source().getBlockNumber();
    const cp = await readCheckpoint(this.deps.store, this.deps.chain.id);
    if (head > cp.lastBlock) {
      await backfillRange(this.source(), this.deps.filters, this.ingest(), head, {
        chunkSize: this.deps.chunkSize,
      });
    }
    this.subscribe();
    this.health.start();
    this.startHeartbeatWatch();
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
    this.subs = [watchBlocks(this.state.active.ws, cb), ...watchLogs(this.state.active.ws, this.deps.filters, cb)];
    this.log.info("subscriptions active", { provider: this.state.active.role, subs: this.subs.map((s) => s.name) });
  }

  private unsubscribe(): void {
    for (const s of this.subs) s.unwatch();
    this.subs = [];
  }

  private async handleBlock(block: { number: bigint; hash: string; parentHash: string; timestamp: bigint }) {
    const chain = this.deps.chain;
    const reorg = await resolveReorg(block, this.source(), this.deps.store, chain.id, chain.confirmations, this.log);
    if (reorg.reorged && reorg.ancestor !== undefined) {
      // Reprocess the canonical range from the common ancestor forward.
      await backfillRange(this.source(), this.deps.filters, this.ingest(), block.number, {
        chunkSize: this.deps.chunkSize,
      });
      return;
    }
    await ingestBlock(block, this.ingest());
    // Reconcile this block's logs via HTTP — dedup makes it free when the
    // live subscription already delivered them. Checkpoint only advances
    // after the block's events are stored AND published.
    const logs = await this.source().getLogs({
      topics: this.deps.filters.flatMap((f) => f.topics),
      fromBlock: block.number,
      toBlock: block.number,
    });
    await ingestLogs(logs, this.ingest());
    await advanceCheckpoint(this.deps.store, chain.id, block.number, null);
    this.log.debug("block processed", { block: block.number.toString(), lag: 0 });
  }

  private async handleLogs(logs: Parameters<typeof ingestLogs>[0]): Promise<void> {
    await ingestLogs(logs, this.ingest());
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
    await backfillRange(this.source(), this.deps.filters, this.ingest(), head, { chunkSize: this.deps.chunkSize });
    this.subscribe();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.unsubscribe();
    this.health.stop();
    await this.processing;
  }
}

/** Run one runner per chain; one chain failing must not stop the others. */
export async function runChains(deps: RunnerDeps[], onChainError?: (chain: ChainConfig, err: unknown) => void): Promise<ChainRunner[]> {
  const runners: ChainRunner[] = [];
  const results = await Promise.allSettled(
    deps.map(async (d) => {
      const runner = new ChainRunner(d);
      await runner.start();
      return runner;
    })
  );
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled") runners.push(r.value);
    else onChainError?.(deps[i].chain, r.reason);
  }
  return runners;
}
