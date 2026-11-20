// Minimal event ABI fragments for the DEX events this engine decodes.

import { parseAbiItem, toEventSelector, type AbiEvent } from "viem";

export const V2_PAIR_CREATED = parseAbiItem(
  "event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"
) as AbiEvent;
export const V3_POOL_CREATED = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, uint24 indexed fee, int24 tickSpacing, address pool)"
) as AbiEvent;
export const AERO_POOL_CREATED = parseAbiItem(
  "event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)"
) as AbiEvent;

export const V2_MINT = parseAbiItem(
  "event Mint(address indexed sender, uint256 amount0, uint256 amount1)"
) as AbiEvent;
export const V2_BURN = parseAbiItem(
  "event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)"
) as AbiEvent;
export const V2_SWAP = parseAbiItem(
  "event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)"
) as AbiEvent;
export const V2_SYNC = parseAbiItem("event Sync(uint112 reserve0, uint112 reserve1)") as AbiEvent;

export const V3_MINT = parseAbiItem(
  "event Mint(address sender, address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)"
) as AbiEvent;
export const V3_BURN = parseAbiItem(
  "event Burn(address indexed owner, int24 indexed tickLower, int24 indexed tickUpper, uint128 amount, uint256 amount0, uint256 amount1)"
) as AbiEvent;
export const V3_SWAP = parseAbiItem(
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)"
) as AbiEvent;

export const FACTORY_EVENTS = {
  v2_pair_created: V2_PAIR_CREATED,
  v3_pool_created: V3_POOL_CREATED,
  aero_pool_created: AERO_POOL_CREATED,
} as const;

export const POOL_EVENTS = {
  v2_mint: V2_MINT,
  v2_burn: V2_BURN,
  v2_swap: V2_SWAP,
  v2_sync: V2_SYNC,
  v3_mint: V3_MINT,
  v3_burn: V3_BURN,
  v3_swap: V3_SWAP,
} as const;

export const TOPIC0: Record<string, AbiEvent> = Object.fromEntries(
  [...Object.values(FACTORY_EVENTS), ...Object.values(POOL_EVENTS)].map((e) => [
    toEventSelector(`${e.name}(${e.inputs.map((i) => i.type).join(",")})`),
    e,
  ])
);
