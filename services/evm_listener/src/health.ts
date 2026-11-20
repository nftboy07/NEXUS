// Periodic provider_health rows (provider, chain, latency ms, error count)
// plus reconnect counters. Latency is measured with a getBlockNumber probe.

import type { Logger } from "@nexus/shared-utils";
import type { ChainSource } from "./rpc.js";
import type { EventStore } from "./store.js";

export interface HealthCounters {
  errors: number;
  reconnects: number;
  outages: number;
}

export class HealthReporter {
  private timer?: ReturnType<typeof setInterval>;
  readonly counters: HealthCounters = { errors: 0, reconnects: 0, outages: 0 };

  constructor(
    private deps: {
      providerName: string;
      chainId: number;
      store: EventStore;
      source: () => ChainSource;
      log: Logger;
      intervalMs?: number;
    }
  ) {}

  async sampleOnce(): Promise<number> {
    const started = Date.now();
    let latency = -1;
    try {
      await this.deps.source().getBlockNumber();
      latency = Date.now() - started;
    } catch (err) {
      this.counters.errors++;
      this.deps.log.warn("health probe failed", { chain_id: this.deps.chainId, err: String(err) });
    }
    await this.deps.store.recordProviderHealth({
      provider: this.deps.providerName,
      chainId: this.deps.chainId,
      latencyMs: latency,
      errors: this.counters.errors,
    });
    return latency;
  }

  start(): void {
    const interval = this.deps.intervalMs ?? 30_000;
    this.timer = setInterval(() => {
      this.sampleOnce().catch((err) =>
        this.deps.log.warn("health sample failed", { chain_id: this.deps.chainId, err: String(err) })
      );
    }, interval);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
