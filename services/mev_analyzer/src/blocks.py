"""Per-block assembly + incremental cursor. Block sequences come from
transactions + Engine 4 liquidity_events swaps; progress is tracked in
mev_analyzer_cursor so runs are incremental and idempotent per block."""
from __future__ import annotations

from models import BlockTxSequence, TxEvent


def assemble_block(store, chain_id: int, block: int) -> BlockTxSequence:
    txs = store.txs_in_block(chain_id, block)
    swaps = store.swaps_in_block(chain_id, block)
    by_tx: dict[str, list[dict]] = {}
    for s in swaps:
        by_tx.setdefault(s["tx_hash"], []).append(s)
    seq = BlockTxSequence(chain_id=chain_id, block_number=block)
    for i, t in enumerate(txs):
        seq.txs.append(TxEvent(
            hash=t["hash"], sender=t.get("sender"),
            block_number=block, position=i, swaps=by_tx.get(t["hash"], []),
        ))
    # swap-only txs (txs not in transactions table) still get a slot
    for h, legs in by_tx.items():
        if all(t.hash != h for t in seq.txs):
            seq.txs.append(TxEvent(
                hash=h, sender=legs[0].get("sender"),
                block_number=block, position=len(seq.txs), swaps=legs,
            ))
    return seq


def analyze_block(store, chain_id: int, block: int, protocol_addrs: dict[str, str],
                  min_impact_pct: float, stats, redis_xadd=None, log=None) -> int:
    """Run all detectors over one block; persist findings idempotently."""
    from arbitrage import find_arbitrage
    from gas import find_gas_outliers
    from liquidations import decode_liquidation
    from sandwich import find_sandwiches
    from findings import persist_findings

    swaps = store.swaps_in_block(chain_id, block)
    txs = store.txs_in_block(chain_id, block)
    known_pools = {s["pool_id"] for s in swaps}

    findings = []
    f_s, insuff = find_sandwiches(
        swaps, lambda pid, blk: store.reserves_at(pid, blk), min_impact_pct)
    stats.insufficient_evidence += insuff
    findings += f_s
    findings += find_arbitrage(swaps, known_pools)

    proto_contracts = set(protocol_addrs.values())
    for row in store.liquidation_logs(chain_id, block, proto_contracts):
        row["chain_id"] = chain_id
        f = decode_liquidation(row, protocol_addrs)
        if f:
            findings.append(f)

    f_g, _ = find_gas_outliers([{**t, "chain_id": chain_id} for t in txs])
    findings += f_g

    stats.blocks_analyzed += 1
    return persist_findings(store, redis_xadd, findings, stats, log)
