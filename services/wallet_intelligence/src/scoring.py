"""Smart Money Score — weights exactly as BLUEPRINT §5, labeled UNVALIDATED
starting weights (test historically before trusting):

    realized_performance        30%
    risk_adjusted_performance   20%
    early_discovery             20%
    consistency                 15%
    behavioral_reliability      15%

Each component is a pure function -> (value 0..1 | None, evidence).
Components with insufficient data return None; the composite reports its
coverage (which components contributed) — never a fabricated full score.
"""
from __future__ import annotations

import statistics
from typing import Optional

from models import ScoreComponent, ScoreComponents, WalletScore

WEIGHTS = {
    "realized_performance": 0.30,
    "risk_adjusted_performance": 0.20,
    "early_discovery": 0.20,
    "consistency": 0.15,
    "behavioral_reliability": 0.15,
}
UNVALIDATED = True  # starting weights; not yet validated historically


def _realized_performance(rows: list[dict]) -> tuple[Optional[float], dict]:
    # Realized PnL requires sell prices. wallet_transfers carries token units,
    # not prices — without a price source there is no honest realized-return
    # number. Returns None rather than fabricating one.
    return None, {
        "reason": "realized PnL requires sale prices; no price source configured (transfers-only data)",
        "transfers_observed": len(rows),
    }


def _risk_adjusted(rows: list[dict]) -> tuple[Optional[float], dict]:
    # Depends on realized performance — same insufficiency.
    return None, {"reason": "derived from realized performance, which is unavailable without prices"}


def _early_discovery(
    rows: list[dict],
    chain_first_inbounds: dict[str, list[int]],
) -> tuple[Optional[float], dict]:
    """Share of the wallet's tokens whose earliest inbound block falls in the
    earliest quartile of all observed first-inbound blocks for that token.
    chain_first_inbounds: token -> sorted list of each wallet's first inbound
    block for that token."""
    inbound: dict[str, int] = {}
    for r in rows:
        token = r["token"]
        b = int(r["block_number"])
        if token not in inbound or b < inbound[token]:
            inbound[token] = b
    if not inbound:
        return None, {"reason": "no inbound transfers observed"}
    early = 0
    for token, first_block in inbound.items():
        peers = chain_first_inbounds.get(token) or []
        if peers:
            quartile = peers[min(len(peers) - 1, len(peers) // 4)]
            if first_block <= quartile:
                early += 1
    return early / len(inbound), {
        "tokens_observed": len(inbound),
        "tokens_in_earliest_quartile": early,
        "method": "first inbound block <= earliest-quartile boundary of observed first-inbounds per token",
    }


def _consistency(rows: list[dict]) -> tuple[Optional[float], dict]:
    """Regularity of activity: 1 - normalized variance of inter-transfer
    block gaps. Needs >= 3 transfers."""
    blocks = sorted(int(r["block_number"]) for r in rows)
    if len(blocks) < 3:
        return None, {"reason": "fewer than 3 transfers; no timing pattern", "transfers_observed": len(blocks)}
    gaps = [b2 - b1 for b1, b2 in zip(blocks, blocks[1:])]
    mean = statistics.mean(gaps)
    if mean == 0:
        return 1.0, {"mean_gap_blocks": 0, "transfers_observed": len(blocks)}
    cv = statistics.pstdev(gaps) / mean
    value = max(0.0, 1.0 - cv)
    return value, {
        "gaps": gaps,
        "mean_gap_blocks": mean,
        "coefficient_of_variation": cv,
        "transfers_observed": len(blocks),
    }


def _behavioral_reliability(rows: list[dict], failed_count: Optional[int]) -> tuple[Optional[float], dict]:
    """1 - failed_tx_share, when failed-tx data exists (transactions table)."""
    tx_hashes = {r["tx_hash"] for r in rows}
    if failed_count is None:
        return None, {"reason": "no transactions rows for this wallet", "txs_observed": len(tx_hashes)}
    total = len(tx_hashes) + failed_count
    if total == 0:
        return None, {"reason": "no transactions observed"}
    return 1.0 - failed_count / total, {
        "txs_observed": len(tx_hashes),
        "failed_txs": failed_count,
        "observability": "transactions rows exist only for txs that emitted ingested logs; "
                         "reverted txs emit no logs, so failed_txs is a lower bound",
    }


def compute_score(
    address: str,
    chain_id: int,
    rows: list[dict],
    chain_first_inbounds: dict[str, list[int]],
    failed_count: Optional[int],
) -> WalletScore:
    """Composite = sum(weight*value)/sum(weights of present components)."""
    rv, re = _realized_performance(rows)
    rav, rae = _risk_adjusted(rows)
    ev, ee = _early_discovery(rows, chain_first_inbounds)
    cv, ce = _consistency(rows)
    bv, be = _behavioral_reliability(rows, failed_count)

    components = ScoreComponents(
        realized_performance=ScoreComponent(value=rv, evidence=re),
        risk_adjusted_performance=ScoreComponent(value=rav, evidence=rae),
        early_discovery=ScoreComponent(value=ev, evidence=ee),
        consistency=ScoreComponent(value=cv, evidence=ce),
        behavioral_reliability=ScoreComponent(value=bv, evidence=be),
    )
    vals = {
        "realized_performance": rv,
        "risk_adjusted_performance": rav,
        "early_discovery": ev,
        "consistency": cv,
        "behavioral_reliability": bv,
    }
    coverage = [k for k, v in vals.items() if v is not None]
    if coverage:
        wsum = sum(WEIGHTS[k] for k in coverage)
        score = sum(WEIGHTS[k] * vals[k] for k in coverage) / wsum
    else:
        score = None
    return WalletScore(
        address=address,
        chain_id=chain_id,
        score=score,
        coverage=coverage,
        components=components,
    )
