"""Related-wallet HYPOTHESES. Emitted ONLY when >=2 independent signal
types are present among: shared funding source; same-token transfers
within a block window; direct prior interaction; repeated similar
timing/size pattern. One signal alone -> no output.

Always a hypothesis: every output ships with evidence AND alternative
explanations (exchange batching, common infrastructure, coincidence).
Never 'same owner' / 'controlled by' language.

Scale: find_hypotheses() builds one RelationIndex per refresh (O(rows)) and
only evaluates candidate pairs that already share a funder, a direct
transfer, or a same-token block bucket — any pair with >=2 signals has at
least one of those three, so no qualifying pair is missed. Groups larger
than MAX_GROUP_SIZE (hub funders such as routers, mint address 0x0, or a
token bucket with hundreds of recipients) are not expanded into pairs:
pairing every wallet a router touched is the "common infrastructure"
alternative, not a relation clue. Such pairs can still surface via a
direct transfer. Skipped groups are counted in the refresh log.
"""
from __future__ import annotations

import bisect
from itertools import combinations
from typing import Optional

from models import RelationHypothesis, RelationSignal

ALTERNATIVES = [
    "exchange batching (a custodian may originate both funding paths)",
    "common infrastructure (shared RPC/relayer/market-maker flows)",
    "coincidence (shared funding sources and timing occur by chance at scale)",
]

SAME_TOKEN_WINDOW_BLOCKS = 500
SIMILAR_PATTERN_TOLERANCE = 0.25
FUNDING_DEPTH = 3  # first N inbound transfers count as funding
MAX_GROUP_SIZE = 50


class RelationIndex:
    """Per-refresh lookup tables over one chain's transfer rows."""

    def __init__(self, rows: list[dict]):
        self.inbound: dict[str, list[dict]] = {}
        self.outbound: dict[str, list[dict]] = {}
        self.direct: dict[frozenset, list[dict]] = {}
        for r in rows:
            self.inbound.setdefault(r["recipient"], []).append(r)
            self.outbound.setdefault(r["sender"], []).append(r)
            if r["sender"] != r["recipient"]:
                self.direct.setdefault(frozenset((r["sender"], r["recipient"])), []).append(r)
        for v in self.inbound.values():
            v.sort(key=lambda r: int(r["block_number"]))
        # wallet -> token -> inbound (block, sender), sorted by block
        self.token_blocks: dict[str, dict[str, list[tuple[int, str]]]] = {}
        for w, rs in self.inbound.items():
            tb: dict[str, list[tuple[int, str]]] = {}
            for r in rs:
                tb.setdefault(r["token"], []).append((int(r["block_number"]), r["sender"]))
            self.token_blocks[w] = tb
        self.out_avg: dict[str, tuple[int, float]] = {
            w: (len(rs), sum(int(r["amount"]) for r in rs) / len(rs))
            for w, rs in self.outbound.items()
        }

    def funders(self, w: str) -> set[str]:
        return {r["sender"] for r in self.inbound.get(w, [])[:FUNDING_DEPTH]}


def _min_gap(
    xs: list[tuple[int, str]], ys: list[tuple[int, str]], excluded: set[str], window: int,
) -> Optional[int]:
    """Smallest block gap <= window between an inbound to a (xs) and an
    inbound to b (ys) that came from DIFFERENT senders, neither of which is
    in `excluded`. One sender paying both wallets is a single event — it is
    the shared-funding signal, not a second independent one."""
    ys_blocks = [b for b, _ in ys]
    best: Optional[int] = None
    for xb, xs_ in xs:
        if xs_ in excluded:
            continue
        i = bisect.bisect_left(ys_blocks, xb)
        for step, j in ((-1, i - 1), (1, i)):
            while 0 <= j < len(ys):
                yb, ys_ = ys[j]
                g = abs(xb - yb)
                if g > window or (best is not None and g >= best):
                    break
                if ys_ != xs_ and ys_ not in excluded:
                    best = g
                    break
                j += step
    return best


def _signals(a: str, b: str, idx: RelationIndex, window_blocks: int) -> list[RelationSignal]:
    signals: list[RelationSignal] = []
    a_in = idx.inbound.get(a, [])
    b_in = idx.inbound.get(b, [])

    # 1) shared funding source: same sender among both wallets' first inbounds
    shared = idx.funders(a) & idx.funders(b)
    if shared:
        evid = [r for r in a_in + b_in if r["sender"] in shared]
        signals.append(RelationSignal(
            kind="shared_funding_source",
            evidence={
                "funders": sorted(shared),
                "tx_hashes": list(dict.fromkeys(r["tx_hash"] for r in evid))[:10],
            },
        ))

    # 2) same-token inbound transfers within a block window (both sides),
    # from distinct senders other than a/b/shared funders, so the evidence
    # never re-uses the transfers behind signals 1 or 3.
    a_tb = idx.token_blocks.get(a, {})
    b_tb = idx.token_blocks.get(b, {})
    excluded = shared | {a, b}
    gaps = {}
    for token in sorted(a_tb.keys() & b_tb.keys()):
        g = _min_gap(a_tb[token], b_tb[token], excluded, window_blocks)
        if g is not None:
            gaps[token] = g
    if gaps:
        signals.append(RelationSignal(
            kind="same_token_window",
            evidence={
                "tokens": sorted(gaps),
                "min_block_gap": min(gaps.values()),
                "window_blocks": window_blocks,
                "independence": "only inbound pairs from distinct senders, excluding a, b and shared funders",
            },
        ))

    # 3) direct prior interaction (a->b or b->a transfer exists)
    direct = idx.direct.get(frozenset((a, b)), []) if a != b else []
    if direct:
        signals.append(RelationSignal(
            kind="direct_interaction",
            evidence={
                "direction": f"{direct[0]['sender']}->{direct[0]['recipient']}",
                "tx_hashes": list(dict.fromkeys(r["tx_hash"] for r in direct))[:10],
                "count": len(direct),
            },
        ))

    # 4) similar size pattern across both wallets' outbound activity
    a_n, a_avg = idx.out_avg.get(a, (0, 0.0))
    b_n, b_avg = idx.out_avg.get(b, (0, 0.0))
    if a_n >= 2 and b_n >= 2 and a_avg > 0 and abs(a_avg - b_avg) / a_avg <= SIMILAR_PATTERN_TOLERANCE:
        signals.append(RelationSignal(
            kind="similar_pattern",
            evidence={
                "a_avg_amount": int(a_avg),
                "b_avg_amount": int(b_avg),
                "a_txs": a_n,
                "b_txs": b_n,
                "tolerance": SIMILAR_PATTERN_TOLERANCE,
            },
        ))
    return signals


def find_signals(
    a: str,
    b: str,
    rows: list[dict],
    window_blocks: int = SAME_TOKEN_WINDOW_BLOCKS,
    index: Optional[RelationIndex] = None,
) -> list[RelationSignal]:
    """All detectable relation signals between wallets a and b."""
    return _signals(a.lower(), b.lower(), index or RelationIndex(rows), window_blocks)


def _build(a: str, b: str, chain_id: int, signals: list[RelationSignal]) -> Optional[RelationHypothesis]:
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


def hypothesize(
    a: str, b: str, chain_id: int, rows: list[dict], index: Optional[RelationIndex] = None,
) -> Optional[RelationHypothesis]:
    """Return a hypothesis only with >=2 independent signal types."""
    return _build(a, b, chain_id, find_signals(a, b, rows, index=index))


def candidate_pairs(
    idx: RelationIndex,
    window_blocks: int = SAME_TOKEN_WINDOW_BLOCKS,
    max_group: int = MAX_GROUP_SIZE,
) -> tuple[set[tuple[str, str]], int]:
    """Pairs sharing a funder, a direct transfer, or a same-token block
    bucket. Returns (pairs, groups_skipped_as_hubs)."""
    pairs: set[tuple[str, str]] = set()
    skipped = 0

    def expand(group: set[str]) -> None:
        nonlocal skipped
        if len(group) < 2:
            return
        if len(group) > max_group:
            skipped += 1
            return
        for x, y in combinations(sorted(group), 2):
            pairs.add((x, y))

    for key in idx.direct:
        x, y = sorted(key)
        pairs.add((x, y))

    by_funder: dict[str, set[str]] = {}
    for w in idx.inbound:
        for f in idx.funders(w):
            by_funder.setdefault(f, set()).add(w)
    for g in by_funder.values():
        expand(g)

    # |ba - bb| <= window  =>  bucket(ba), bucket(bb) differ by at most 1
    w = max(1, window_blocks)
    buckets: dict[tuple[str, int], set[str]] = {}
    for wallet, tb in idx.token_blocks.items():
        for token, blocks in tb.items():
            for blk, _ in blocks:
                buckets.setdefault((token, blk // w), set()).add(wallet)
    for (token, bkt), g in buckets.items():
        expand(g | buckets.get((token, bkt + 1), set()))
    return pairs, skipped


def find_hypotheses(
    chain_id: int,
    rows: list[dict],
    stats: Optional[dict] = None,
) -> list[RelationHypothesis]:
    idx = RelationIndex(rows)
    pairs, skipped = candidate_pairs(idx)
    out = []
    for a, b in sorted(pairs):
        h = _build(a, b, chain_id, _signals(a, b, idx, SAME_TOKEN_WINDOW_BLOCKS))
        if h:
            out.append(h)
    if stats is not None:
        stats.update({"candidate_pairs": len(pairs), "hub_groups_skipped": skipped,
                      "hypotheses": len(out)})
    return out
