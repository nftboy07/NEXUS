// Decode normalized log events into typed DEX events. Unknown
// contracts/signatures are ignored, never guessed.

import { decodeEventLog, type AbiEvent } from "viem";
import type { NexusNormalizedEvent } from "@nexus/event-schemas";
import { TOPIC0, V2_PAIR_CREATED, V3_POOL_CREATED, AERO_POOL_CREATED, V2_MINT, V2_BURN, V2_SWAP, V2_SYNC, V3_MINT, V3_BURN, V3_SWAP } from "./abis.js";

export type DexEvent =
  | {
      kind: "PoolCreated";
      dex: string;
      dexType: "v2" | "v3" | "aerodrome";
      token0: string;
      token1: string;
      pool: string;
      feeTier: number | null;
      stable?: boolean;
    }
  | { kind: "LiquidityAdded"; sender: string; amount0: bigint; amount1: bigint; v3: boolean }
  | { kind: "LiquidityRemoved"; sender: string; to?: string; amount0: bigint; amount1: bigint; v3: boolean }
  | {
      kind: "Swap";
      sender: string;
      amount0In: bigint;
      amount1In: bigint;
      amount0Out: bigint;
      amount1Out: bigint;
      v3: boolean;
      sqrtPriceX96?: bigint;
    }
  | { kind: "ReserveUpdate"; reserve0: bigint; reserve1: bigint };

export interface DecodeContext {
  /** factory address (lowercase) -> {dex name, type} */
  factories: Map<string, { name: string; type: "v2" | "v3" | "aerodrome" }>;
  /** Is this contract a registered pool on this chain? */
  isPool: (address: string) => boolean;
}

interface RawLogShape {
  contract: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

const addr = (v: unknown) => String(v).toLowerCase();

/** Positional decode: viem returns args as an index-keyed array. */
function decodeArgs(event: AbiEvent, topics: string[], data: string): unknown[] {
  const d = decodeEventLog({ abi: [event], data: data as `0x${string}`, topics: topics as never });
  const args = d.args as unknown;
  return event.inputs.map((input, i) => {
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const rec = args as Record<string, unknown>;
      if (input.name && input.name in rec) return rec[input.name];
    }
    return (args as unknown[])[i];
  });
}

/**
 * Decode a normalized log event into a typed DEX event.
 * Returns null for anything not from a known factory or registered pool.
 */
export function decodeLogEvent(ev: NexusNormalizedEvent, ctx: DecodeContext): DexEvent | null {
  const log = ev.payload as unknown as RawLogShape;
  if (!log || log.removed || !Array.isArray(log.topics) || log.topics.length === 0) return null;
  const topic0 = log.topics[0];
  const event = TOPIC0[topic0];
  if (!event) return null;
  const address = log.contract.toLowerCase();

  // Factory events: only from configured factory addresses.
  if (event === V2_PAIR_CREATED || event === V3_POOL_CREATED || event === AERO_POOL_CREATED) {
    const factory = ctx.factories.get(address);
    if (!factory) return null;
    const a = decodeArgs(event, log.topics, log.data);
    if (event === V2_PAIR_CREATED) {
      // (token0, token1, pair, uint256)
      return {
        kind: "PoolCreated",
        dex: factory.name,
        dexType: "v2",
        token0: addr(a[0]),
        token1: addr(a[1]),
        pool: addr(a[2]),
        feeTier: null,
      };
    }
    if (event === V3_POOL_CREATED) {
      // (token0, token1, fee, tickSpacing, pool)
      return {
        kind: "PoolCreated",
        dex: factory.name,
        dexType: "v3",
        token0: addr(a[0]),
        token1: addr(a[1]),
        pool: addr(a[4]),
        feeTier: Number(a[2]),
      };
    }
    // aerodrome (token0, token1, stable, pool, uint256)
    return {
      kind: "PoolCreated",
      dex: factory.name,
      dexType: "aerodrome",
      token0: addr(a[0]),
      token1: addr(a[1]),
      pool: addr(a[3]),
      feeTier: null,
      stable: Boolean(a[2]),
    };
  }

  // Pool events: only from registered pools.
  if (!ctx.isPool(address)) return null;
  const a = decodeArgs(event, log.topics, log.data);

  if (event === V2_MINT) {
    // (sender, amount0, amount1)
    return { kind: "LiquidityAdded", sender: addr(a[0]), amount0: BigInt(a[1] as bigint), amount1: BigInt(a[2] as bigint), v3: false };
  }
  if (event === V3_MINT) {
    // (sender, owner, tickLower, tickUpper, amount, amount0, amount1)
    return { kind: "LiquidityAdded", sender: addr(a[1]), amount0: BigInt(a[5] as bigint), amount1: BigInt(a[6] as bigint), v3: true };
  }
  if (event === V2_BURN) {
    // (sender, amount0, amount1, to)
    return { kind: "LiquidityRemoved", sender: addr(a[0]), to: addr(a[3]), amount0: BigInt(a[1] as bigint), amount1: BigInt(a[2] as bigint), v3: false };
  }
  if (event === V3_BURN) {
    // (owner, tickLower, tickUpper, amount, amount0, amount1)
    return { kind: "LiquidityRemoved", sender: addr(a[0]), amount0: BigInt(a[4] as bigint), amount1: BigInt(a[5] as bigint), v3: true };
  }
  if (event === V2_SWAP) {
    // (sender, amount0In, amount1In, amount0Out, amount1Out, to)
    return {
      kind: "Swap",
      sender: addr(a[0]),
      amount0In: BigInt(a[1] as bigint),
      amount1In: BigInt(a[2] as bigint),
      amount0Out: BigInt(a[3] as bigint),
      amount1Out: BigInt(a[4] as bigint),
      v3: false,
    };
  }
  if (event === V3_SWAP) {
    // (sender, recipient, amount0, amount1, sqrtPriceX96, liquidity, tick)
    const a0 = BigInt(a[2] as bigint);
    const a1 = BigInt(a[3] as bigint);
    return {
      kind: "Swap",
      sender: addr(a[0]),
      amount0In: a0 > 0n ? a0 : 0n,
      amount1In: a1 > 0n ? a1 : 0n,
      amount0Out: a0 < 0n ? -a0 : 0n,
      amount1Out: a1 < 0n ? -a1 : 0n,
      v3: true,
      sqrtPriceX96: BigInt(a[4] as bigint),
    };
  }
  if (event === V2_SYNC) {
    // (reserve0, reserve1)
    return { kind: "ReserveUpdate", reserve0: BigInt(a[0] as bigint), reserve1: BigInt(a[1] as bigint) };
  }
  return null;
}
