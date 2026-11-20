"""Potential-sandwich detection over ordered swap legs of one block. ALL
conditions required (a resemblance, never proven intent):

  same pool; front leg A1 by initiator X (tx.from); victim leg V by a
  different sender, same direction, ordered (log_index) after A1; back leg
  A2 by X in a different tx, opposite direction, ordered after V. The
  victim-impact estimate is the pool price move caused by A1 (pre vs post
  A1, from stored Sync / V3 sqrtPriceX96 — see swaps.py). If that move is
  not derivable from stored logs the candidate is NOT emitted and counted
  insufficient evidence.
"""
from __future__ import annotations

from models import Confidence, Finding
from swaps import direction, price_move_pct

MIN_VICTIM_IMPACT_PCT_DEFAULT = 0.5


def _gross_profit(a1: dict, a2: dict) -> dict:
    """Initiator's gross delta in A1's input token: what A2 returned minus
    what A1 spent. Excludes gas, builder tips and any unclosed position."""
    d = direction(a1)
    spent = int(a1[f"amount{d}_in"])
    got = int(a2[f"amount{d}_out"])
    return {"token": a1.get(f"token{d}"), "raw_delta": str(got - spent)}


def find_sandwiches(legs: list[dict], chain_id: int,
                    min_impact_pct: float = MIN_VICTIM_IMPACT_PCT_DEFAULT) -> tuple[list[Finding], int]:
    """legs: one block's swap legs (swaps.decode_legs shape), any order.
    Returns (findings, insufficient_evidence_count)."""
    findings: list[Finding] = []
    insufficient = 0
    by_pool: dict[str, list[dict]] = {}
    for leg in sorted(legs, key=lambda x: x["log_index"]):
        by_pool.setdefault(leg["pool_id"], []).append(leg)

    for pool_id, pl in by_pool.items():
        used_back: set[int] = set()
        for i, a1 in enumerate(pl):
            x = a1.get("sender")
            if not x or i in used_back:
                continue
            match = None
            for k in range(i + 2, len(pl)):
                a2 = pl[k]
                if a2.get("sender") != x or a2["tx_hash"] == a1["tx_hash"] or direction(a2) == direction(a1):
                    continue
                victims = [v for v in pl[i + 1:k]
                           if v.get("sender") and v["sender"] != x and direction(v) == direction(a1)
                           and v["tx_hash"] not in (a1["tx_hash"], a2["tx_hash"])]
                if victims:
                    match = (k, a2, victims)
                    break
            if match is None:
                continue
            k, a2, victims = match
            impact = price_move_pct(a1)
            if impact is None:
                insufficient += 1
                continue
            if impact < min_impact_pct:
                continue
            used_back.add(k)
            profit = _gross_profit(a1, a2)
            high = impact >= 2 * min_impact_pct and int(profit["raw_delta"]) > 0
            ev = lambda leg, role: {"tx_hash": leg["tx_hash"], "block_number": leg["block_number"],  # noqa: E731
                                    "log_index": leg["log_index"], "role": role, "sender": leg.get("sender"),
                                    "amount0_in": str(leg["amount0_in"]), "amount1_in": str(leg["amount1_in"]),
                                    "amount0_out": str(leg["amount0_out"]), "amount1_out": str(leg["amount1_out"])}
            findings.append(Finding(
                kind="potential_sandwich",
                chain_id=chain_id,
                block_number=int(a1["block_number"]),
                initiator=x,
                victim=victims[0]["sender"],
                pool_id=pool_id,
                evidence=[ev(a1, "front_leg"), *[ev(v, "victim") for v in victims], ev(a2, "back_leg")],
                estimated_impact={
                    "victim_impact_pct_estimate": impact,
                    "initiator_gross_profit_estimate": profit,
                    "method": "pool price move caused by the front leg (pre vs post reserves/sqrtPrice "
                              "from stored logs); profit = back-leg output minus front-leg input in the "
                              "front leg's input token, raw units; excludes gas/fees/tips",
                },
                confidence=Confidence(
                    level="high" if high else "medium",
                    rationale="potential sandwich pattern — same-pool A1->V->A2 ordering by log_index "
                              "resembling a sandwich; resemblance only, never proven intent",
                ),
            ))
    return findings, insufficient
