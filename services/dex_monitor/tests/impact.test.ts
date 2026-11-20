import { describe, expect, it } from "vitest";
import { estimateImpact } from "../src/impact.js";

describe("estimateImpact (constant-product, 0.3% fee)", () => {
  it("hand-computed: 1% of reserve on a balanced 1e6/1e6 pool", () => {
    // reserveIn = reserveOut = 1_000_000; dx = 10_000
    // amountOut = dx*9970*rOut / (rIn*10000 + dx*9970)
    //         = 10000*9970*1000000 / (1000000*10000 + 10000*9970)
    //         = 99700000000000 / 10099700000 ≈ 9877.44...
    const [est] = estimateImpact(1_000_000n, 1_000_000n, [0.01]);
    const expectedOut = (10_000n * 9_970n * 1_000_000n) / (1_000_000n * 10_000n + 10_000n * 9_970n);
    expect(est.amountIn).toBe(10_000n);
    expect(est.amountOut).toBe(expectedOut);
    // effective price = out/in = 9871/10000 = 0.9871; impact = 1.29%
    expect(est.impactPct).toBeCloseTo(1.29, 3);
  });

  it("hand-computed: asymmetric reserves", () => {
    // rIn=2_000_000, rOut=1_000_000; spot=0.5; dx=0.1% = 2000
    const [est] = estimateImpact(2_000_000n, 1_000_000n, [0.001]);
    const expectedOut = (2_000n * 9_970n * 1_000_000n) / (2_000_000n * 10_000n + 2_000n * 9_970n);
    expect(est.amountOut).toBe(expectedOut);
    const eff = Number(expectedOut) / 2000;
    expect(est.impactPct).toBeCloseTo((1 - eff / 0.5) * 100, 6);
    expect(est.impactPct).toBeCloseTo(0.4, 3);
  });

  it("larger trade -> larger impact", () => {
    const ests = estimateImpact(1_000_000n, 1_000_000n);
    expect(ests.map((e) => e.sizeFraction)).toEqual([0.001, 0.01, 0.05]);
    expect(ests[0].impactPct).toBeLessThan(ests[1].impactPct);
    expect(ests[1].impactPct).toBeLessThan(ests[2].impactPct);
  });

  it("empty reserves -> no estimates", () => {
    expect(estimateImpact(0n, 1_000n)).toEqual([]);
    expect(estimateImpact(1_000n, 0n)).toEqual([]);
  });
});
