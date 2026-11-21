from clusters import find_signals, hypothesize

from conftest import make_transfer


def test_one_signal_no_hypothesis():
    # only shared funding source (different tokens -> no same_token_window)
    rows = [
        make_transfer(sender="0xfunder", recipient="0xa1", token="0xt1", block_number=100, tx_hash="0x1").model_dump(),
        make_transfer(sender="0xfunder", recipient="0xa2", token="0xt2", block_number=101, tx_hash="0x2").model_dump(),
    ]
    assert len(find_signals("0xa1", "0xa2", rows)) == 1
    assert hypothesize("0xa1", "0xa2", 1, rows) is None


def test_two_signals_hypothesis_with_alternatives():
    rows = [
        # shared funder
        make_transfer(sender="0xfunder", recipient="0xa1", block_number=100, tx_hash="0x1").model_dump(),
        make_transfer(sender="0xfunder", recipient="0xa2", block_number=101, tx_hash="0x2").model_dump(),
        # same token inbound within window, from two distinct sources
        make_transfer(sender="0xsrc1", recipient="0xa1", token="0xt2", block_number=200, tx_hash="0x3").model_dump(),
        make_transfer(sender="0xsrc2", recipient="0xa2", token="0xt2", block_number=210, tx_hash="0x4").model_dump(),
    ]
    h = hypothesize("0xa1", "0xa2", 1, rows)
    assert h is not None
    kinds = {s.kind for s in h.signals}
    assert kinds == {"shared_funding_source", "same_token_window"}
    assert "hypothesis" in h.kind  # related_wallet_hypothesis
    assert "HYPOTHESIS" in h.description
    assert len(h.alternatives) >= 3
    assert any("exchange batching" in a for a in h.alternatives)
    assert any("coincidence" in a for a in h.alternatives)
    assert "same owner" not in h.description
    assert "controlled" not in h.description


def test_direct_interaction_alone_no_hypothesis():
    rows = [
        make_transfer(sender="0xa1", recipient="0xa2", block_number=100, tx_hash="0x1").model_dump(),
    ]
    assert hypothesize("0xa1", "0xa2", 1, rows) is None


def test_one_sender_batching_same_token_is_one_signal_not_two():
    # 0xfunder pays both wallets the same token in adjacent blocks: that is a
    # single event (shared funding), not also an independent same-token signal.
    rows = [
        make_transfer(sender="0xfunder", recipient="0xa1", block_number=100, tx_hash="0x1").model_dump(),
        make_transfer(sender="0xfunder", recipient="0xa2", block_number=101, tx_hash="0x2").model_dump(),
    ]
    assert [s.kind for s in find_signals("0xa1", "0xa2", rows)] == ["shared_funding_source"]
    assert hypothesize("0xa1", "0xa2", 1, rows) is None


def test_direct_transfer_does_not_double_as_same_token_signal():
    # a1 -> a2 of token T; a1 also received T earlier. The a2 side's only T
    # inbound is the direct transfer itself, so same_token_window must not fire.
    rows = [
        make_transfer(sender="0xpool", recipient="0xa1", block_number=100, tx_hash="0x1").model_dump(),
        make_transfer(sender="0xa1", recipient="0xa2", block_number=101, tx_hash="0x2").model_dump(),
    ]
    assert [s.kind for s in find_signals("0xa1", "0xa2", rows)] == ["direct_interaction"]
