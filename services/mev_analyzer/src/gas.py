"""Per-block priority-fee statistics. Engine 1's transactions table does not
store gas fields today, so rows only carry priority_fee when an enrichment
column exists; txs without the field are skipped (counted, never guessed).
Flags txs whose priority fee exceeds the block's 95th percentile by
GAS_OUTLIER_MULTIPLE (default 3x). A statistical observation, not an MEV claim.
"""
from __future__ import annotations

import statistics

from models import Confidence, Finding

GAS_OUTLIER_MULTIPLE_DEFAULT = 3.0


def find_gas_outliers(txs: list[dict], multiple: float = GAS_OUTLIER_MULTIPLE_DEFAULT) -> tuple[list[Finding], int]:
    """txs: {hash, sender, block_number, chain_id, priority_fee?}."""
    with_fee = [t for t in txs if t.get("priority_fee") is not None]
    if len(with_fee) < 4:
        return [], len(txs) - len(with_fee)
    fees = sorted(int(t["priority_fee"]) for t in with_fee)
    p95 = fees[min(len(fees) - 1, int(len(fees) * 0.95))]
    findings = []
    for t in with_fee:
        fee = int(t["priority_fee"])
        if p95 > 0 and fee > p95 * multiple:
            findings.append(Finding(
                kind="gas_outlier",
                chain_id=int(t.get("chain_id") or 0),
                block_number=int(t["block_number"]),
                initiator=t.get("sender"),
                victim=None,
                pool_id=None,
                evidence=[{"tx_hash": t["hash"], "block_number": t["block_number"], "priority_fee": str(fee)}],
                estimated_impact={
                    "priority_fee": str(fee),
                    "block_p95": str(p95),
                    "multiple": multiple,
                },
                confidence=Confidence(
                    level="low",
                    rationale="statistical observation: priority fee above block p95 "
                              f"by {multiple}x — not an MEV claim",
                ),
            ))
    return findings, 0
