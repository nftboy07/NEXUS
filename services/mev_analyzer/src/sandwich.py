"""Potential-sandwich detection. ALL conditions required (a resemblance,
never proven intent):

  same pool; within one block, tx A1 (initiator X swaps), victim tx V
  (different sender, same pool+pair direction, ordered between A1 and A2),
  tx A2 (initiator X swaps back). Victim impact is estimated as the price
  move A1 caused vs the pre-A1 reserves (constant-product, 0.3% fee —
  same formulas as Engine 4 impact.ts). If reserves at that block are
  unavailable the candidate is NOT emitted and counted insufficient.
"""
from __future__ import annotations

from typing import Optional

from models import Confidence, Finding

MIN_VICTIM_IMPACT_PCT_DEFAULT = 0.5


def _impact_pct(amount_in: int, reserve_in: int, reserve_out: int, fee_num: int = 997) -> float:
    """Engine 4 formula: out = dx*feeNum*rOut / (rIn*10000 + dx*feeNum);
    impact = 1 - effectivePrice/spotPrice, in percent."""
    if reserve_in <= 0 or reserve_out <= 0:
        return 0.0
    spot = reserve_out / reserve_in
    out = (amount_in * fee_num * reserve_out) / (reserve_in * 10_000 + amount_in * fee_num)
    eff = out / amount_in if amount_in else 0.0
    return (1 - eff / spot) * 100 if spot > 0 else 0.0


def find_sandwiches(
    swaps: list[dict],
    reserves_for,
    min_impact_pct: float = MIN_VICTIM_IMPACT_PCT_DEFAULT,
) -> tuple[list[Finding], int]:
    """swaps: ordered rows {tx_hash, sender, pool_id, amount0, amount1,
    block_number}. reserves_for(pool_id, block) -> reserve dict|None.
    Returns (findings, insufficient_evidence_count)."""
    findings: list[Finding] = []
    insufficient = 0
    by_pool: dict[str, list[dict]] = {}
    for s in swaps:
        by_pool.setdefault(s["pool_id"], []).append(s)

    for pool_id, legs in by_pool.items():
        senders: dict[str, list[int]] = {}
        for i, leg in enumerate(legs):
            if leg.get("sender"):
                senders.setdefault(leg["sender"], []).append(i)
        for sender, idxs in senders.items():
            if len(idxs) < 2:
                continue
            a1_i, a2_i = idxs[0], idxs[-1]
            a1, a2 = legs[a1_i], legs[a2_i]
            for v_i in range(a1_i + 1, a2_i):
                v = legs[v_i]
                if v.get("sender") == sender or not v.get("sender"):
                    continue
                # same direction: both push the same input side
                if (int(a1["amount0"] or 0) > 0) != (int(v["amount0"] or 0) > 0):
                    continue
                # A2 swaps back: opposite input side to A1
                if (int(a2["amount0"] or 0) > 0) == (int(a1["amount0"] or 0) > 0):
                    continue
                res = reserves_for(pool_id, a1["block_number"])
                if res is None or res["reserve0"] is None:
                    insufficient += 1
                    continue
                amount_in = int(a1["amount0"] or a1["amount1"] or 0)
                reserve_in = int(res["reserve0"] if a1["amount0"] else res["reserve1"])
                reserve_out = int(res["reserve1"] if a1["amount0"] else res["reserve0"])
                impact = _impact_pct(amount_in, reserve_in, reserve_out)
                if impact < min_impact_pct:
                    continue
                chain_id = int(str(pool_id).split(":")[0]) if ":" in str(pool_id) else 0
                findings.append(Finding(
                    kind="potential_sandwich",
                    chain_id=chain_id,
                    block_number=int(a1["block_number"]),
                    initiator=sender,
                    victim=v.get("sender"),
                    pool_id=pool_id,
                    evidence=[
                        {"tx_hash": a1["tx_hash"], "block_number": a1["block_number"], "role": "front_leg"},
                        {"tx_hash": v["tx_hash"], "block_number": v["block_number"], "role": "victim"},
                        {"tx_hash": a2["tx_hash"], "block_number": a2["block_number"], "role": "back_leg"},
                    ],
                    estimated_impact={
                        "victim_impact_pct_estimate": impact,
                        "method": "constant-product price move caused by front leg "
                                  "(same formula as Engine 4 impact.ts; excludes gas/fees)",
                    },
                    confidence=Confidence(
                        level="medium" if impact < 2 * min_impact_pct else "high",
                        rationale="potential sandwich pattern — same-pool A1->V->A2 ordering "
                                  "resembling a sandwich; resemblance only, never proven intent",
                    ),
                ))
    return findings, insufficient
