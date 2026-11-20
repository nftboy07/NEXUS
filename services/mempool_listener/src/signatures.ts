// Method-signature table: 4-byte selector -> name + decode ABI fragment.
// Unknown selectors stay unknown — never guess a decode.

import { parseAbiItem, toFunctionSelector, type AbiFunction } from "viem";

export interface MethodSig {
  name: string;
  abi: AbiFunction;
}

const A = (sig: string) => parseAbiItem(`function ${sig}`) as AbiFunction;

const METHODS: Array<{ name: string; abi: AbiFunction }> = [
  // Uniswap V2 router
  { name: "swapExactTokensForTokens", abi: A("swapExactTokensForTokens(uint256,uint256,address[],address,uint256)") },
  { name: "swapExactETHForTokens", abi: A("swapExactETHForTokens(uint256,address[],address,uint256)") },
  { name: "addLiquidity", abi: A("addLiquidity(address,address,uint256,uint256,uint256,uint256,address,uint256)") },
  { name: "addLiquidityETH", abi: A("addLiquidityETH(address,uint256,uint256,uint256,address,uint256)") },
  { name: "removeLiquidity", abi: A("removeLiquidity(address,address,uint256,uint256,uint256,address,uint256)") },
  { name: "removeLiquidityETH", abi: A("removeLiquidityETH(address,uint256,uint256,address,uint256)") },
  // Uniswap V3 SwapRouter + NonfungiblePositionManager
  { name: "exactInputSingle", abi: A("exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))") },
  { name: "exactInput", abi: A("exactInput((bytes,address,uint256,uint256,uint256))") },
  { name: "mint", abi: A("mint((address,address,uint24,int24,int24,uint256,uint256,uint256,uint256,address,uint256))") },
  { name: "increaseLiquidity", abi: A("increaseLiquidity((uint256,uint256,uint256,uint256,uint256,uint256))") },
  { name: "decreaseLiquidity", abi: A("decreaseLiquidity((uint256,uint128,uint256,uint256,uint256))") },
  // ERC-20
  { name: "transfer", abi: A("transfer(address,uint256)") },
  { name: "approve", abi: A("approve(address,uint256)") },
];

const TABLE = new Map<string, MethodSig>();
for (const m of METHODS) TABLE.set(toFunctionSelector(m.abi).toLowerCase(), m);

export function lookupSelector(selector: string): MethodSig | null {
  return TABLE.get(selector.toLowerCase()) ?? null;
}

export const KNOWN_METHODS = [...TABLE.keys()];
