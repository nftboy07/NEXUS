// Reserve tracking: V2/Aerodrome Sync events give full reserves; V3 Swaps
// carry sqrtPriceX96 + liquidity but not full reserves -> source 'partial'.

import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { DexEvent } from "./decoders.js";
import type { DexStore } from "./store.js";
import { poolId } from "./store.js";

export async function recordReserveUpdate(
  store: DexStore,
  ev: NexusNormalizedEvent,
  poolAddress: string,
  decoded: Extract<DexEvent, { kind: "ReserveUpdate" | "Swap" }>
): Promise<void> {
  const pid = poolId(ev.chain_id, poolAddress);
  if (decoded.kind === "ReserveUpdate") {
    await store.insertPoolReserve({
      poolId: pid,
      chainId: ev.chain_id,
      reserve0: decoded.reserve0.toString(),
      reserve1: decoded.reserve1.toString(),
      source: "sync",
      blockNumber: BigInt(ev.block_number ?? 0),
    });
    return;
  }
  if (decoded.kind === "Swap" && decoded.v3) {
    // Full V3 reserves are not derivable from the swap log alone — record a
    // partial marker so downstream metrics can name the missing source.
    await store.insertPoolReserve({
      poolId: pid,
      chainId: ev.chain_id,
      reserve0: null,
      reserve1: null,
      source: "partial",
      blockNumber: BigInt(ev.block_number ?? 0),
    });
  }
}
