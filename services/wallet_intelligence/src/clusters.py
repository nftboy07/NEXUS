"""Related-wallet HYPOTHESES. Emitted ONLY when >=2 independent signal
types are present among: shared funding source; same-token transfers
within a block window; direct prior interaction; repeated similar
timing/size pattern. One signal alone -> no output.

Always a hypothesis: every output ships with evidence AND alternative
explanations (exchange batching, common infrastructure, coincidence).
Never 'same owner' / 'controlled by' language.
"""
from __future__ import annotations

from typing import Optional

from models import RelationHypothesis, RelationSignal

ALTERNATIVES = [
    "exchange batching (a custodian may originate both funding paths)",
    "common infrastructure (shared RPC/relayer/market-maker flows)",
    "coincidence (shared funding sources and timing occur by chance at scale)",
]

SAME_TOKEN_WINDOW_BLOCKS = 500
SIMILAR_PATTERN_TOLERANCE = 0.25


def _first_inbound_per_wallet(rows: list[dict]) -> dict[str, list[dict]]:
    """wallet -> its inbound transfers ordered by block (first = funding)."""
    inbound: dict[str, list[dict]] = {}
    for r in rows:
        inbound.setdefault(r["recipient"], []).append(r)
    for v in inbound.values():
        v.sort(key=lambda r: int(r["block_number"]))
    return inbound


def find_signals(
    a: str,
    b: str,
    rows: list[dict],
    window_blocks: int = SAME_TOKEN_WINDOW_BLOCKS,
) -> list[RelationSignal]:
    """All detectable relation signals between wallets a and b."""
    a, b = a.lower(), b.lower()
    signals: list[RelationSignal] = []
    inbound = _first_inbound_per_wallet(rows)
    a_in = inbound.get(a, [])
    b_in = inbound.get(b, [])

    # 1) shared funding source: same sender funded both wallets first
    a_funders = {r["sender"] for r in a_in[:3]}
    b_funders = {r["sender"] for r in b_in[:3]}
    shared = a_funders & b_funders
    if shared:
        evid = [r for r in a_in + b_in if r["sender"] in shared]
        signals.append(RelationSignal(
            kind="shared_funding_source",
            evidence={
                "funders": sorted(shared),
                "tx_hashes": [r["tx_hash"] for r in evid[:10]],
            },
        ))

    # 2) same-token transfers within a block window (both sides)
    a_tokens = {(r["token"], int(r["block_number"])) for r in a_in}
    b_tokens = {(r["token"], int(r["block_number"])) for r in b_in}
    close = [
        (ta, ba, bb)
        for (ta, ba) in a_tokens
        for (tb, bb) in b_tokens
        if ta == tb and abs(ba - bb) <= window_blocks
    ]
    if close:
        signals.append(RelationSignal(
            kind="same_token_window",
            evidence={
                "tokens": sorted({t for t, _, _ in close}),
                "min_block_gap": min(abs(ba - bb) for _, ba, bb in close),
                "window_blocks": window_blocks,
            },
        ))

    # 3) direct prior interaction (a->b or b->a transfer exists)
    direct = [
        r for r in rows
        if (r["sender"] == a and r["recipient"] == b)
        or (r["sender"] == b and r["recipient"] == a)
    ]
    if direct:
        signals.append(RelationSignal(
            kind="direct_interaction",
            evidence={
                "direction": f"{direct[0]['sender']}->{direct[0]['recipient']}",
                "tx_hashes": [r["tx_hash"] for r in direct[:10]],
                "count": len(direct),
            },
        ))

    # 4) similar timing/size pattern across both wallets' outbound activity
    a_out = [r for r in rows if r["sender"] == a]
    b_out = [r for r in rows if r["sender"] == b]
    if len(a_out) >= 2 and len(b_out) >= 2:
        a_avg = sum(int(r["amount"]) for r in a_out) / len(a_out)
        b_avg = sum(int(r["amount"]) for r in b_out) / len(b_out)
        if a_avg > 0 and abs(a_avg - b_avg) / a_avg <= SIMILAR_PATTERN_TOLERANCE:
            signals.append(RelationSignal(
                kind="similar_pattern",
                evidence={
                    "a_avg_amount": int(a_avg),
                    "b_avg_amount": int(b_avg),
                    "a_txs": len(a_out),
                    "b_txs": len(b_out),
                    "tolerance": SIMILAR_PATTERN_TOLERANCE,
                },
            ))
    return signals


def hypothesize(a: str, b: str, chain_id: int, rows: list[dict]) -> Optional[RelationHypothesis]:
    """Return a hypothesis only with >=2 independent signal types."""
    signals = find_signals(a, b, rows)
    if len(signals) < 2:
        return None
    confidence = "high" if len(signals) >= 3 else "medium"
    return RelationHypothesis(
        address_a=min(a, b),
        address_b=max(a, b),
        chain_id=chain_id,
        signals=signals,
        confidence=confidence,
        alternatives=ALTERNATIVES,
        description=(
            f"HYPOTHESIS: {a} and {b} show {len(signals)} independent relation "
            f"signals ({', '.join(s.kind for s in signals)}). This is a clue, "
            "not evidence of common ownership; see alternatives."
        ),
    )


def find_hypotheses(chain_id: int, rows: list[dict]) -> list[RelationHypothesis]:
    wallets = sorted({r["sender"] for r in rows} | {r["recipient"] for r in rows})
    out = []
    for i, a in enumerate(wallets):
        for b in wallets[i + 1:]:
            h = hypothesize(a, b, chain_id, rows)
            if h:
                out.append(h)
    return out
