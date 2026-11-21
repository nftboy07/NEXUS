"""Range analysis: swap legs + liquidation logs for [from_block, to_block]
are read once, grouped per block, and every detector runs per block.
Progress is tracked by the caller in mev_analyzer_cursor; persistence is
idempotent (unique key per finding), so re-analysing a range is safe."""
from __future__ import annotations

from arbitrage import find_arbitrage
from findings import persist_findings
from liquidations import decode_liquidation
from sandwich import find_sandwiches
from swaps import decode_legs


def analyze_range(store, chain_id: int, from_block: int, to_block: int,
                  protocol_addrs: dict[str, str], min_impact_pct: float,
                  stats, redis_xadd=None, log=None) -> int:
    rows = store.swap_logs(chain_id, from_block, to_block)
    legs = decode_legs(rows, store.prev_v3_sqrt)
    by_block: dict[int, list[dict]] = {}
    for leg in legs:
        by_block.setdefault(leg["block_number"], []).append(leg)
    stats.swap_legs += len(legs)

    findings = []
    for block in sorted(by_block):
        bl = by_block[block]
        f_s, insuff = find_sandwiches(bl, chain_id, min_impact_pct)
        stats.insufficient_evidence += insuff
        findings += f_s
        findings += find_arbitrage(bl, chain_id)

    for row in store.liquidation_logs(chain_id, from_block, to_block, set(protocol_addrs.values())):
        row["chain_id"] = chain_id
        f = decode_liquidation(row, protocol_addrs)
        if f:
            findings.append(f)

    stats.blocks_analyzed += to_block - from_block + 1
    return persist_findings(store, redis_xadd, findings, stats, log)
