// Liquidity add/remove accounting: liquidity_events rows + pool totals.

import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import type { DexEvent } from "./decoders.js";
import type { DexStore } from "./store.js";
import { poolId } from "./store.js";

export async function recordLiquidityEvent(
  store: DexStore,
  ev: NexusNormalizedEvent,
  poolAddress: string,
  decoded: Extract<DexEvent, { kind: "LiquidityAdded" | "LiquidityRemoved" | "Swap" }>
): Promise<void> {
  const eventType = decoded.kind === "LiquidityAdded" ? "add" : decoded.kind === "LiquidityRemoved" ? "remove" : "swap";
  await store.insertLiquidityEvent({
    poolId: poolId(ev.chain_id, poolAddress),
    chainId: ev.chain_id,
    eventType,
    amount0: decoded.kind === "Swap" ? decoded.amount0In.toString() : decoded.amount0.toString(),
    amount1: decoded.kind === "Swap" ? decoded.amount1In.toString() : decoded.amount1.toString(),
    txHash: ev.tx_hash ?? "",
    blockNumber: BigInt(ev.block_number ?? 0),
    blockHash: ev.block_hash ?? null,
  });
}

/**
 * Removal as a fraction of the pool's pre-removal net liquidity, per asset
 * side (max of the two). Net liquidity = adds - removes over stored history;
 * the current removal is excluded (caller computes before inserting it, or
 * subtract it back).
 */
export function removalFraction(
  removed0: bigint,
  removed1: bigint,
  net0Before: bigint,
  net1Before: bigint
): number {
  const f0 = net0Before > 0n ? Number(removed0) / Number(net0Before) : 0;
  const f1 = net1Before > 0n ? Number(removed1) / Number(net1Before) : 0;
  return Math.max(f0, f1);
}
