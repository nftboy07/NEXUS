import { describe, it, expect } from "vitest";
import { explorerTx, explorerAddress } from "../lib/explorers";

describe("explorer links", () => {
  it("builds etherscan tx links for mainnet", () => {
    expect(explorerTx(1, "0xabc")).toBe("https://etherscan.io/tx/0xabc");
  });
  it("builds basescan address links", () => {
    expect(explorerAddress(8453, "0xdef")).toBe("https://basescan.org/address/0xdef");
  });
  it("strips chain-prefixed pool ids", () => {
    expect(explorerAddress(1, "1:0xpool")).toBe("https://etherscan.io/address/0xpool");
  });
  it("returns null for unknown chains", () => {
    expect(explorerTx(999, "0x")).toBeNull();
  });
});
