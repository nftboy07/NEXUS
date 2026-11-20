// Pending-tx decode: destination / value / method via the signature table,
// deployment detection, and token/pair extraction where the calldata
// determines it. Every inferred field is flagged as an estimate — a pending
// decode is a hint from one node's mempool, never confirmed activity.

import { decodeFunctionData } from "viem";
import { lookupSelector } from "./signatures.js";

export interface DecodedTx {
  kind: "deployment" | "call" | "transfer";
  to: string | null;
  selector: string | null;
  method: string | null;   // null = unknown selector / no calldata
  tokens: string[];        // token addresses present in calldata (decoded args only)
  pair: string | null;     // pool/pair address when determinable; null otherwise
  value: string;           // wei
  /** Every field below is an estimate derived from calldata, not a fact. */
  estimate: {
    token_in?: string;
    token_out?: string;
    amount_in?: string;
    min_out?: string;
    path?: string[];
  };
}

export function decodeTx(tx: { to: string | null; input: string; value: bigint }): DecodedTx {
  const value = tx.value.toString();
  const base: DecodedTx = {
    kind: tx.to === null ? "deployment" : tx.input === "0x" ? "transfer" : "call",
    to: tx.to,
    selector: null,
    method: null,
    tokens: [],
    pair: null,
    value,
    estimate: {},
  };
  if (tx.to === null) return base; // contract deployment
  const input = tx.input;
  if (input === "0x" || input.length < 10) return base;
  const selector = input.slice(0, 10).toLowerCase();
  base.selector = selector;
  const sig = lookupSelector(selector);
  if (!sig) return base; // unknown stays unknown — never guess
  base.method = sig.name;
  try {
    const decoded = decodeFunctionData({ abi: [sig.abi], data: input as `0x${string}` });
    const a = decoded.args as readonly unknown[];
    switch (sig.name) {
      case "swapExactTokensForTokens": {
        const path = a[2] as string[];
        base.tokens = path.map((t) => t.toLowerCase());
        base.estimate = {
          token_in: path[0].toLowerCase(),
          token_out: path[path.length - 1].toLowerCase(),
          amount_in: (a[0] as bigint).toString(),
          min_out: (a[1] as bigint).toString(),
          path,
        };
        break;
      }
      case "swapExactETHForTokens": {
        const path = a[1] as string[];
        base.tokens = path.map((t) => t.toLowerCase());
        base.estimate = {
          token_out: path[path.length - 1].toLowerCase(),
          amount_in: value,
          min_out: (a[0] as bigint).toString(),
          path,
        };
        break;
      }
      case "addLiquidity":
      case "removeLiquidity": {
        base.tokens = [(a[0] as string).toLowerCase(), (a[1] as string).toLowerCase()];
        break;
      }
      case "addLiquidityETH":
      case "removeLiquidityETH": {
        base.tokens = [(a[0] as string).toLowerCase()];
        break;
      }
      case "exactInputSingle": {
        // viem decodes tuple args positionally; order is
        // (tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96)
        const p = Object.values(a[0] as object) as [string, string, unknown, string, bigint, bigint, bigint, bigint];
        base.tokens = [p[0].toLowerCase(), p[1].toLowerCase()];
        base.estimate = {
          token_in: p[0].toLowerCase(),
          token_out: p[1].toLowerCase(),
          amount_in: p[5].toString(),
          min_out: p[6].toString(),
        };
        break;
      }
      case "mint": {
        const p = Object.values(a[0] as object) as string[];
        base.tokens = [p[0].toLowerCase(), p[1].toLowerCase()];
        break;
      }
      case "transfer": {
        base.tokens = [tx.to.toLowerCase()];
        base.estimate = { token_in: tx.to.toLowerCase(), amount_in: (a[1] as bigint).toString() };
        break;
      }
      case "approve": {
        base.tokens = [tx.to.toLowerCase()];
        break;
      }
      default:
        break;
    }
  } catch {
    // Calldata doesn't match the ABI fragment: method name still recorded,
    // token/estimate fields left empty rather than guessed.
  }
  return base;
}
