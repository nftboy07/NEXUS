import { describe, expect, it } from "vitest";
import { buildBlockDedupKey, buildLogDedupKey, parseDedupKey } from "../src/dedup.js";

const BH = "0x" + "ab".repeat(32);
const TX = "0x" + "cd".repeat(32);

describe("dedup keys", () => {
  it("builds a log key in the documented order", () => {
    expect(buildLogDedupKey(1, BH, TX, 3)).toBe(`1:${BH}:${TX}:3`);
  });

  it("builds a block key", () => {
    expect(buildBlockDedupKey(8453, BH)).toBe(`8453:${BH}`);
  });

  it("round-trips a log key", () => {
    const parsed = parseDedupKey(buildLogDedupKey(1, BH, TX, 7));
    expect(parsed).toEqual({ kind: "log", chainId: 1, blockHash: BH, txHash: TX, logIndex: 7 });
  });

  it("round-trips a block key", () => {
    const parsed = parseDedupKey(buildBlockDedupKey(8453, BH));
    expect(parsed).toEqual({ kind: "block", chainId: 8453, blockHash: BH });
  });

  it("rejects malformed keys", () => {
    expect(() => parseDedupKey("onlyone")).toThrow();
    expect(() => parseDedupKey("a:b:c")).toThrow();
  });
});
