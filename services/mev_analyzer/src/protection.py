"""Pre-trade protection check (pure function + importable):
(chain_id, pool_id, token_in, amount_in) -> expected impact % + slippage
warning from pool_reserves via constant-product math consistent with
Engine 4 impact.ts (out = dx*997*rOut / (rIn*10000 + dx*997); impact =
1 - effectivePrice/spotPrice). Stale reserves (> PROTECTION_MAX_RESERVE_AGE
_BLOCKS, default 100) -> impact null, staleness stated; never guessed.
"""
from __future__ import annotations

from typing import Optional, Protocol

from models import ProtectionReport

MAX_AGE_DEFAULT = 100


class ReserveSource(Protocol):
    def reserves_at(self, pool_id: str, block: int) -> Optional[dict]: ...


def check_trade(
    pool_id: str,
    token_in: str,
    amount_in: int,
    token0: str,
    head_block: int,
    reserves: ReserveSource,
    max_age_blocks: int = MAX_AGE_DEFAULT,
    chain_id: int = 0,
) -> ProtectionReport:
    res = reserves.reserves_at(pool_id, head_block)
    report = ProtectionReport(
        chain_id=chain_id, pool_id=pool_id, token_in=token_in, amount_in=amount_in,
        impact_pct=None, reserve_block=None, reserve_age_blocks=None,
    )
    if res is None:
        report.note = "no reserves on record for pool; impact cannot be estimated"
        return report
    report.reserve_block = int(res["block_number"])
    report.reserve_age_blocks = head_block - report.reserve_block
    if report.reserve_age_blocks > max_age_blocks:
        report.stale = True
        report.note = f"reserve snapshot is {report.reserve_age_blocks} blocks old (> {max_age_blocks}); impact not estimated"
        return report

    is_token0_in = token_in.lower() == token0.lower()
    reserve_in = int(res["reserve0"] if is_token0_in else res["reserve1"])
    reserve_out = int(res["reserve1"] if is_token0_in else res["reserve0"])
    if reserve_in <= 0 or reserve_out <= 0 or amount_in <= 0:
        report.note = "non-positive reserves or input; impact cannot be estimated"
        return report
    spot = reserve_out / reserve_in
    out = (amount_in * 997 * reserve_out) / (reserve_in * 10_000 + amount_in * 997)
    impact = (1 - (out / amount_in) / spot) * 100
    report.impact_pct = impact
    if impact >= 5:
        report.slippage_warning = f"high expected impact: {impact:.2f}% of pool depth"
    elif impact >= 1:
        report.slippage_warning = f"moderate expected impact: {impact:.2f}%"
    return report
