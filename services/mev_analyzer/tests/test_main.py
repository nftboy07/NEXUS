import logging

from findings import RunStats
from main import plan_chunks, run_pass

from test_sandwich import planted

CFG = {"chain_ids": [1, 8453], "min_impact": 0.5, "batch": 50, "max_blocks": 20, "confirmations": 2}


def test_plan_chunks():
    assert plan_chunks(None, 100, 50, 20) == [(51, 70), (71, 90), (91, 100)]
    assert plan_chunks(95, 100, 50, 20) == [(96, 100)]
    assert plan_chunks(100, 100, 50, 20) == []


def test_run_pass_advances_cursor_per_chain(store):
    store.rows[1] = planted()
    store.checkpoints = {1: 102}           # chain 8453 has no checkpoint: skipped
    stats = RunStats()
    run_pass(store, None, {}, CFG, logging.getLogger("t"), stats)
    assert store.cursors == {1: 100}       # checkpoint - confirmations
    assert stats.blocks_analyzed == 50 and len(store.findings) == 1
    run_pass(store, None, {}, CFG, logging.getLogger("t"), stats)
    assert store.cursors == {1: 100} and len(store.findings) == 1


def test_failing_chain_does_not_stop_others(store):
    store.checkpoints = {1: 102, 8453: 1002}
    orig = store.swap_logs

    def boom(cid, a, b):
        if cid == 1:
            raise RuntimeError("db hiccup")
        return orig(cid, a, b)
    store.swap_logs = boom
    run_pass(store, None, {}, CFG, logging.getLogger("t"), RunStats())
    assert 1 not in store.cursors and store.cursors[8453] == 1000
