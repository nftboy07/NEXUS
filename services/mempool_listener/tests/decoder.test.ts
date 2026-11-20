// Decoder tests against real recorded calldata (see fixtures/README.md).

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { decodeTx } from "../src/decoder.js";

const fx = JSON.parse(
  readFileSync(new URL("./fixtures/pending_txs.json", import.meta.url), "utf8"),
) as { txs: Record<string, { hash: string; to: string | null; input: string; value: string }> };

const dec = (name: string) => {
  const tx = fx.txs[name];
  return decodeTx({ to: tx.to, input: tx.input, value: BigInt(tx.value) });
};

describe("decodeTx on recorded calldata", () => {
  it("V2 swapExactTokensForTokens -> method + path tokens (estimates flagged)", () => {
    const d = dec("v2_swapExactTokensForTokens");
    expect(d.method).toBe("swapExactTokensForTokens");
    expect(d.estimate.path!.length).toBeGreaterThanOrEqual(2);
    expect(d.estimate.token_in).toBe(d.estimate.path![0].toLowerCase());
    expect(d.estimate.token_out).toBe(d.estimate.path!.at(-1)!.toLowerCase());
  });

  it("V2 swapExactETHForTokens -> method + token_out", () => {
    const d = dec("v2_swapExactETHForTokens");
    expect(d.method).toBe("swapExactETHForTokens");
    expect(d.estimate.token_out).toBeTruthy();
  });

  it("V2 addLiquidity + addLiquidityETH -> token addresses", () => {
    expect(dec("v2_addLiquidity").method).toBe("addLiquidity");
    expect(dec("v2_addLiquidity").tokens).toHaveLength(2);
    expect(dec("v2_addLiquidityETH").method).toBe("addLiquidityETH");
    expect(dec("v2_addLiquidityETH").tokens).toHaveLength(1);
  });

  it("V3 exactInputSingle -> tokenIn/tokenOut", () => {
    const d = dec("v3_exactInputSingle");
    expect(d.method).toBe("exactInputSingle");
    expect(d.tokens).toHaveLength(2);
    expect(d.estimate.token_in).toBe(d.tokens[0]);
    expect(d.estimate.token_out).toBe(d.tokens[1]);
  });

  it("V3 increaseLiquidity decodes to its method", () => {
    expect(dec("v3_increaseLiquidity").method).toBe("increaseLiquidity");
  });

  it("ERC-20 transfer/approve -> token is the contract address", () => {
    const t = dec("erc20_transfer");
    expect(t.method).toBe("transfer");
    expect(t.tokens).toEqual([fx.txs.erc20_transfer.to!.toLowerCase()]);
    expect(dec("erc20_approve").method).toBe("approve");
  });

  it("deployment (to == null) is identified", () => {
    const d = dec("deployment");
    expect(d.kind).toBe("deployment");
    expect(d.method).toBeNull();
  });

  it("unknown selector stays unknown", () => {
    const d = decodeTx({
      to: "0x" + "1".repeat(40),
      input: "0xdeadbeef" + "00".repeat(64),
      value: 0n,
    });
    expect(d.method).toBeNull();
    expect(d.selector).toBe("0xdeadbeef");
    expect(d.tokens).toEqual([]);
  });

  it("plain ETH transfer has no method", () => {
    const d = decodeTx({ to: "0x" + "1".repeat(40), input: "0x", value: 5n });
    expect(d.kind).toBe("transfer");
    expect(d.method).toBeNull();
  });
});
