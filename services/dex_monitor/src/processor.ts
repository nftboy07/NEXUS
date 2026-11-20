// Event pipeline: normalized log event -> decode -> pool registry /
// liquidity_events / pool_reserves / removal alerts. Idempotent: replayed
// logs change nothing twice (upserts + alert dedup_key).

import { readFileSync } from "node:fs";
import type { Logger } from "@nexus/shared-utils";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import { decodeLogEvent, type DecodeContext } from "./decoders.js";
import { PoolRegistry } from "./pools.js";
import { recordLiquidityEvent } from "./liquidity.js";
import { recordReserveUpdate } from "./reserves.js";
import { maybeAlertRemoval, type AlertSink } from "./alerts.js";
import type { DexStore } from "./store.js";

const DEXES_URL = new URL("../../../packages/chain_config/dexes.json", import.meta.url);

export interface DexEntry {
  chain_id: number;
  name: string;
  type: "v2" | "v3" | "aerodrome";
  factory: string;
  router: string;
  address_source: string;
}

export function loadDexes(url: URL = DEXES_URL): DexEntry[] {
  return (JSON.parse(readFileSync(url, "utf8")) as { dexes: DexEntry[] }).dexes;
}

export type FactoryMap = Map<string, { name: string; type: "v2" | "v3" | "aerodrome" }>;

export function buildFactoryMap(dexes: DexEntry[], chainId: number): FactoryMap {
  const m: FactoryMap = new Map();
  for (const d of dexes) {
    if (d.chain_id === chainId) m.set(d.factory.toLowerCase(), { name: d.name, type: d.type });
  }
  return m;
}

export interface ProcessorDeps {
  store: DexStore;
  registry: PoolRegistry;
  factories: FactoryMap;
  sink: AlertSink;
  removalThresholdPct: number;
  log: Logger;
}

export class DexProcessor {
  private known = new Set<string>();

  constructor(private deps: ProcessorDeps) {}

  async handleEvent(ev: NexusNormalizedEvent): Promise<void> {
    if (ev.kind !== "log") return;
    const payload = ev.payload as { contract?: string; removed?: boolean };
    if (!payload.contract || payload.removed) return;
    const address = payload.contract.toLowerCase();
    const isFactory = this.deps.factories.has(address);
    const isPool = isFactory ? false : await this.deps.registry.isPool(ev.chain_id, address);
    if (!isFactory && !isPool) return;

    const ctx: DecodeContext = {
      factories: this.deps.factories,
      isPool: (a) => a.toLowerCase() === address && isPool,
    };
    const decoded = decodeLogEvent(ev, ctx);
    if (!decoded) return;

    switch (decoded.kind) {
      case "PoolCreated": {
        const row = await this.deps.registry.register(decoded, ev);
        this.deps.log.info("pool registered", { pool_id: row.id, dex: row.dex });
        return;
      }
      case "LiquidityAdded":
        await recordLiquidityEvent(this.deps.store, ev, address, decoded);
        return;
      case "LiquidityRemoved": {
        const pool = await this.deps.store.getPool(ev.chain_id, address);
        // net liquidity BEFORE recording this removal -> removal share of pool
        const net = await this.deps.store.netLiquidity(`${ev.chain_id}:${address}`);
        await recordLiquidityEvent(this.deps.store, ev, address, decoded);
        if (pool) {
          await maybeAlertRemoval({
            ev,
            pool,
            poolAddress: address,
            sender: decoded.sender,
            removed0: decoded.amount0,
            removed1: decoded.amount1,
            net0Before: net.amount0,
            net1Before: net.amount1,
            thresholdPct: this.deps.removalThresholdPct,
            sink: this.deps.sink,
            store: this.deps.store,
            log: this.deps.log,
          });
        }
        return;
      }
      case "Swap":
        await recordLiquidityEvent(this.deps.store, ev, address, decoded);
        await recordReserveUpdate(this.deps.store, ev, address, decoded);
        return;
      case "ReserveUpdate":
        await recordReserveUpdate(this.deps.store, ev, address, decoded);
        return;
    }
  }
}
