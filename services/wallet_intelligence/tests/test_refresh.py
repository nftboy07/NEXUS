"""Live-path refresh: scores + relations for every chain, at stream scale."""
import logging
import random
import time
from itertools import combinations

import clusters
import main
from clusters import RelationIndex, _build, _signals, candidate_pairs, find_hypotheses

from conftest import make_transfer

LOG = logging.getLogger("test")


def _add(store, **kw):
    kw.setdefault("dedup_key", f"{kw.get('chain_id', 1)}:{kw['tx_hash']}")
    store.insert_transfer(make_transfer(**kw))


def _two_signal_pair(store, chain_id):
    _add(store, chain_id=chain_id, sender="0xfunder", recipient="0xa1", block_number=100, tx_hash=f"0x{chain_id}1")
    _add(store, chain_id=chain_id, sender="0xfunder", recipient="0xa2", block_number=101, tx_hash=f"0x{chain_id}2")
    _add(store, chain_id=chain_id, sender="0xsrc1", recipient="0xa1", token="0xt2", block_number=200, tx_hash=f"0x{chain_id}3")
    _add(store, chain_id=chain_id, sender="0xsrc2", recipient="0xa2", token="0xt2", block_number=210, tx_hash=f"0x{chain_id}4")


def test_refresh_all_scores_every_chain_and_writes_relations(store):
    _two_signal_pair(store, 1)
    _two_signal_pair(store, 8453)
    n = main.refresh_all(store, LOG)
    assert n == 10  # 5 wallets x 2 chains
    for cid in (1, 8453):
        assert {a for a, c in store.scores if c == cid} == {"0xfunder", "0xsrc1", "0xsrc2", "0xa1", "0xa2"}
        rel = store.relations[("0xa1", "0xa2", cid)]
        assert {s["kind"] for s in rel["signals"]} == {"shared_funding_source", "same_token_window"}
        assert any("exchange batching" in a for a in rel["alternatives"])
    s = store.scores[("0xa1", 1)]
    # early_discovery has data; no prices / no transactions rows -> None, not fabricated
    assert s["coverage"] == ["early_discovery"]
    assert s["components"]["behavioral_reliability"]["value"] is None
    assert s["components"]["realized_performance"]["value"] is None


def test_refresh_prunes_rows_no_longer_supported(store):
    _two_signal_pair(store, 1)
    _two_signal_pair(store, 8453)
    main.refresh_all(store, LOG)
    assert ("0xa1", "0xa2", 1) in store.relations
    # reorg-style removal of a2's same-token inbound: pair drops to 1 signal
    store.transfers = [t for t in store.transfers if not (t.chain_id == 1 and t.tx_hash == "0x14")]
    main.refresh_all(store, LOG)
    assert ("0xa1", "0xa2", 1) not in store.relations
    assert ("0xsrc2", 1) not in store.scores
    assert ("0xa1", "0xa2", 8453) in store.relations  # other chain untouched
    assert ("0xsrc2", 8453) in store.scores


def test_refresh_empty_store_is_noop(store):
    assert main.refresh_all(store, LOG) == 0
    assert store.scores == {} and store.commits == 0


def test_scores_committed_even_if_relation_pass_fails(store, monkeypatch):
    _two_signal_pair(store, 1)

    def boom(*a, **k):
        raise RuntimeError("relation pass failed")

    monkeypatch.setattr(main, "find_hypotheses", boom)
    main.refresh_all(store, LOG)  # must not raise into the consumer loop
    assert len(store.scores) == 5
    assert store.commits == 1
    assert store.relations == {}


def test_behavioral_reliability_uses_batched_failed_counts(store):
    _two_signal_pair(store, 1)
    store.failed[(1, "0xfunder")] = 0
    main.refresh_all(store, LOG)
    comp = store.scores[("0xfunder", 1)]["components"]["behavioral_reliability"]
    assert comp["value"] == 1.0 and comp["evidence"]["failed_txs"] == 0
    assert store.scores[("0xa1", 1)]["components"]["behavioral_reliability"]["value"] is None


def _random_rows(seed, wallets, n, tokens, step):
    rnd = random.Random(seed)
    w = [f"0x{i:040x}" for i in range(wallets)]
    return [dict(chain_id=1, token=f"0xt{rnd.randint(0, tokens)}", sender=rnd.choice(w),
                 recipient=rnd.choice(w), amount=rnd.choice([100, 110, 5000, 10**6]),
                 tx_hash=f"0x{i}", block_number=1000 + i * step, ts=None) for i in range(n)]


def test_candidate_pairs_match_all_pairs_brute_force(monkeypatch):
    rows = _random_rows(2, 120, 300, 5, 7)
    monkeypatch.setattr(clusters, "MAX_GROUP_SIZE", 10**9)
    idx = RelationIndex(rows)
    wallets = sorted({r["sender"] for r in rows} | {r["recipient"] for r in rows})
    brute = [h for a, b in combinations(wallets, 2)
             if (h := _build(a, b, 1, _signals(a, b, idx, clusters.SAME_TOKEN_WINDOW_BLOCKS)))]
    fast = find_hypotheses(1, rows)
    assert brute  # fixture actually exercises the path
    assert [h.model_dump() for h in fast] == [h.model_dump() for h in brute]


def test_hub_funder_not_expanded_into_pairs():
    rows = [make_transfer(sender="0xrouter", recipient=f"0xw{i:02d}", token=f"0xt{i}",
                          block_number=100 + i * 1000, tx_hash=f"0x{i}").model_dump()
            for i in range(clusters.MAX_GROUP_SIZE + 1)]
    pairs, skipped = candidate_pairs(RelationIndex(rows))
    assert skipped == 1
    assert pairs == {tuple(sorted(("0xrouter", f"0xw{i:02d}"))) for i in range(clusters.MAX_GROUP_SIZE + 1)}


def test_refresh_scales_to_live_stream_volume(store):
    rows = _random_rows(3, 3000, 20000, 30, 0)
    for r in rows:
        r["block_number"] = 10**6 + int(r["tx_hash"][2:]) // 5
    store.all_transfers = lambda chain_id: rows
    store.transfer_chain_ids = lambda: [1]
    t = time.monotonic()
    n = main.refresh_all(store, LOG)
    assert n > 2500
    assert time.monotonic() - t < 20  # was O(wallets^2 x rows): hours at this size
    assert len(store.scores) == n
