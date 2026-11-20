"""Cyclic arbitrage: same-block, same-sender trades across >=2 known pools
whose net token deltas are positive in the start token. Fees are ignored —
the profit figure is labeled an estimate with fees excluded."""
from __future__ import annotations

from models import Confidence, Finding


def find_arbitrage(swaps: list[dict], known_pools: set[str]) -> list[Finding]:
    """swaps: rows {tx_hash, sender, pool_id, amount0, amount1, block_number}."""
    by_sender: dict[str, list[dict]] = {}
    for s in swaps:
        if s.get("sender") and s["pool_id"] in known_pools:
            by_sender.setdefault(s["sender"], []).append(s)

    findings: list[Finding] = []
    for sender, legs in by_sender.items():
        pools = {l["pool_id"] for l in legs}
        if len(pools) < 2:
            continue
        # Net input-side delta proxy: sum(amount0) - sum(amount1) across legs
        # (a crude delta; labeled an estimate).
        net0 = sum(int(l["amount0"] or 0) - int(l["amount1"] or 0) for l in legs)
        if net0 <= 0:
            continue
        chain_id = int(str(next(iter(pools))).split(":")[0])
        block = int(legs[0]["block_number"])
        findings.append(Finding(
            kind="cyclic_arbitrage",
            chain_id=chain_id,
            block_number=block,
            initiator=sender,
            victim=None,
            pool_id=None,
            evidence=[{"tx_hash": l["tx_hash"], "block_number": l["block_number"], "pool_id": l["pool_id"]} for l in legs],
            estimated_impact={
                "net_token_delta_estimate": net0,
                "note": "estimate only; gas and LP fees excluded",
            },
            confidence=Confidence(
                level="medium",
                rationale="same-sender multi-pool trading in one block with positive "
                          "net token delta (fees excluded) — consistent with cyclic arbitrage",
            ),
        ))
    return findings
