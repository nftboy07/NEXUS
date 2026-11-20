from blocks import analyze_block
from findings import RunStats

from conftest import swap


def test_repeated_analysis_no_duplicates(store):
    import logging
    pool = "1:uniswap_v2:0xpool"
    store.reserves[pool] = {"pool_id": pool, "reserve0": 10_000_000, "reserve1": 20_000_000, "block_number": 100}
    store.swaps[(1, 100)] = [
        swap("0xa1", "0xattacker", pool, 500_000, 0),
        swap("0xv", "0xvictim", pool, 100_000, 0),
        swap("0xa2", "0xattacker", pool, 0, 900_000),
    ]
    store.txs[(1, 100)] = [{"hash": "0xa1", "sender": "0xattacker", "block_number": 100, "value": "0"}]
    stats = RunStats()
    n1 = analyze_block(store, 1, 100, {}, 0.5, stats, None, logging.getLogger("t"))
    n2 = analyze_block(store, 1, 100, {}, 0.5, stats, None, logging.getLogger("t"))
    assert n1 == 1 and n2 == 0
    assert len(store.findings) == 1
    # high-confidence finding -> alert emitted once
    assert len(store.alerts) == 1
