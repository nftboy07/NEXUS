"""Cyclic arbitrage: one tx swapping through >=2 registered pools whose
per-token net (out - in, using each pool's token0/token1) is never negative
and positive for at least one token — a closed cycle that ends with more of
some token than it started. Ordinary multi-hop swaps spend their input token
(negative net) and are not flagged. Only legs on registered pools are seen,
so cycles through unregistered pools are missed, never guessed. Fees and gas
are excluded — the profit figure is an estimate."""
from __future__ import annotations

from models import Confidence, Finding


def find_arbitrage(legs: list[dict], chain_id: int) -> list[Finding]:
    by_tx: dict[str, list[dict]] = {}
    for leg in legs:
        by_tx.setdefault(leg["tx_hash"], []).append(leg)

    findings: list[Finding] = []
    for tx, tl in by_tx.items():
        pools = sorted({l["pool_id"] for l in tl})
        sender = tl[0].get("sender")
        if len(pools) < 2 or not sender or any(not l.get("token0") or not l.get("token1") for l in tl):
            continue
        net: dict[str, int] = {}
        for l in tl:
            for side in (0, 1):
                tok = l[f"token{side}"].lower()
                net[tok] = net.get(tok, 0) + int(l[f"amount{side}_out"]) - int(l[f"amount{side}_in"])
        if any(v < 0 for v in net.values()) or not any(v > 0 for v in net.values()):
            continue
        findings.append(Finding(
            kind="cyclic_arbitrage",
            chain_id=chain_id,
            block_number=int(tl[0]["block_number"]),
            initiator=sender,
            victim=None,
            pool_id=",".join(pools),
            evidence=[{"tx_hash": l["tx_hash"], "block_number": l["block_number"], "log_index": l["log_index"],
                       "pool_id": l["pool_id"]} for l in sorted(tl, key=lambda x: x["log_index"])],
            estimated_impact={
                "net_token_delta_estimate": {k: str(v) for k, v in sorted(net.items()) if v},
                "note": "estimate only, raw token units; gas and LP fees excluded",
            },
            confidence=Confidence(
                level="medium",
                rationale="one tx trading a closed cycle across registered pools with non-negative "
                          "net in every token and positive net in at least one (fees excluded)",
            ),
        ))
    return findings
