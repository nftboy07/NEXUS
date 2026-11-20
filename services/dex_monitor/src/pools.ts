// Pool registry: upsert pools rows on PoolCreated; keep a known-pool set so
// pair events from unregistered contracts are ignored.

import type { DexStore, PoolRow } from "./store.js";
import { poolId } from "./store.js";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { DexEvent } from "./decoders.js";

export class PoolRegistry {
  private known = new Set<string>(); // poolId values

  constructor(private store: DexStore) {}

  /** Register a decoded PoolCreated. Idempotent (ON CONFLICT DO NOTHING). */
  async register(created: Extract<DexEvent, { kind: "PoolCreated" }>, ev: NexusNormalizedEvent): Promise<PoolRow> {
    const row: PoolRow = {
      id: poolId(ev.chain_id, created.pool),
      dex: created.dex,
      token0: created.token0,
      token1: created.token1,
      chainId: ev.chain_id,
      feeTier: created.feeTier,
      createdBlock: ev.block_number === null ? null : BigInt(ev.block_number),
      createdTx: ev.tx_hash,
      blockHash: ev.block_hash ?? null,
    };
    await this.store.upsertPool(row);
    this.known.add(row.id);
    return row;
  }

  /** Known-pool check for the decoder context; hydrates lazily from the store. */
  async isPool(chainId: number, address: string): Promise<boolean> {
    const id = poolId(chainId, address);
    if (this.known.has(id)) return true;
    const row = await this.store.getPool(chainId, address);
    if (row) {
      this.known.add(id);
      return true;
    }
    return false;
  }

  markKnown(chainId: number, address: string): void {
    this.known.add(poolId(chainId, address));
  }
}
