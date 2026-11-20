from profiles import build_profile

from conftest import make_transfer


def test_hand_computed_profile(store):
    # wallet 0xb: 2 inbound (100 t1, 50 t2), 1 outbound (30 t1)
    ts = [
        make_transfer(sender="0xs1", recipient="0xb", token="0xt1", amount=100, block_number=100, tx_hash="0x1"),
        make_transfer(sender="0xs2", recipient="0xb", token="0xt2", amount=50, block_number=110, tx_hash="0x2"),
        make_transfer(sender="0xb", recipient="0xd", token="0xt1", amount=30, block_number=120, tx_hash="0x3"),
    ]
    for t in ts:
        store.insert_transfer(t)
    store.wallets["0xb"] = {"label": "test-wallet", "label_source": "manual"}
    store.failed[(1, "0xb")] = 0

    p = build_profile(store, 1, "0xb")
    assert p.label == "test-wallet"
    assert p.label_source == "manual"
    assert p.first_seen_block == 100
    assert p.tx_count_in == 2
    assert p.tx_count_out == 1
    assert p.total_in_by_token == {"0xt1": 100, "0xt2": 50}
    assert p.total_out_by_token == {"0xt1": 30}
    assert set(p.top_counterparties) == {"0xs1", "0xs2", "0xd"}
    assert p.funding_sources[:2] == ["0xs1", "0xs2"]
    assert p.typical_tx_size == 50  # median of 100, 50, 30
    assert p.activity_span_blocks == 20
    assert p.failed_tx_count == 0


def test_empty_profile_nulls(store):
    p = build_profile(store, 1, "0xempty")
    assert p.first_seen_block is None
    assert p.tx_count_in == 0
    assert p.typical_tx_size is None
    assert p.activity_span_blocks is None
    assert p.label is None
