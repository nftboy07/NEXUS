// Constant-product price-impact estimation for representative trade sizes
// expressed as fractions of the input-side reserve. Pure function of
// reserves — no external price data. Uniswap V2 math incl. the 0.3% fee.

export interface ImpactEstimate {
  /** trade size as a fraction of reserveIn (e.g. 0.01 = 1% of depth) */
  sizeFraction: number;
  amountIn: bigint;
  amountOut: bigint;
  /** price impact vs the pre-trade spot price, in percent */
  impactPct: number;
}

export const DEFAULT_SIZE_FRACTIONS = [0.001, 0.01, 0.05]; // 0.1%, 1%, 5% of input reserve

export function estimateImpact(
  reserveIn: bigint,
  reserveOut: bigint,
  sizeFractions: number[] = DEFAULT_SIZE_FRACTIONS,
  feeBps = 30
): ImpactEstimate[] {
  if (reserveIn <= 0n || reserveOut <= 0n) return [];
  const spotPrice = Number(reserveOut) / Number(reserveIn);
  const feeNum = 10_000 - feeBps;
  return sizeFractions.map((sizeFraction) => {
    const amountIn = BigInt(Math.round(Number(reserveIn) * sizeFraction));
    // Uniswap V2: amountOut = (dx * feeNum * reserveOut) / (reserveIn*10000 + dx*feeNum)
    const amountOut = (amountIn * BigInt(feeNum) * reserveOut) / (reserveIn * 10_000n + amountIn * BigInt(feeNum));
    const effectivePrice = amountIn > 0n ? Number(amountOut) / Number(amountIn) : 0;
    const impactPct = spotPrice > 0 ? (1 - effectivePrice / spotPrice) * 100 : 0;
    return { sizeFraction, amountIn, amountOut, impactPct };
  });
}
