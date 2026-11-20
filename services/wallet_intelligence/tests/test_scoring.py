from scoring import WEIGHTS, compute_score

from conftest import make_transfer


def rows_for(address, transfers):
    out = []
    for t in transfers:
        out.append({
            "chain_id": t.chain_id, "token": t.token, "sender": t.sender,
            "recipient": t.recipient, "amount": t.amount, "tx_hash": t.tx_hash,
            "block_number": t.block_number, "ts": None,
        })
    return out


def test_weights_exact():
    assert WEIGHTS == {
        "realized_performance": 0.30,
        "risk_adjusted_performance": 0.20,
        "early_discovery": 0.20,
        "consistency": 0.15,
        "behavioral_reliability": 0.15,
    }


def test_no_realized_data_is_none():
    ts = [make_transfer(block_number=100 + i * 10, tx_hash=f"0x{i}") for i in range(4)]
    s = compute_score("0xb", 1, rows_for("0xb", ts), {"0xtoken": [100]}, None)
    assert s.components.realized_performance.value is None
    assert "no price source" in s.components.realized_performance.evidence["reason"]
    assert s.components.risk_adjusted_performance.value is None


def test_composite_coverage_no_fabrication():
    # 4 evenly spaced inbound transfers -> early_discovery + consistency;
    # failed=None -> behavioral_reliability None; perf components None.
    ts = [make_transfer(recipient="0xb", block_number=100 + i * 10, tx_hash=f"0x{i}", sender=f"0xs{i}")
          for i in range(4)]
    # earliest quartile boundary for 4 peers = index 1 -> block 120; our
    # wallet's first inbound (100) is within it.
    chain_first = {"0xtoken": [100, 120, 5000, 9000]}
    s = compute_score("0xb", 1, rows_for("0xb", ts), chain_first, None)
    assert s.components.early_discovery.value == 1.0
    assert s.components.consistency.value is not None
    assert set(s.coverage) == {"early_discovery", "consistency"}
    assert s.score is not None
    # composite = (0.20*ed + 0.15*cons) / 0.35
    expected = (0.20 * 1.0 + 0.15 * s.components.consistency.value) / 0.35
    assert abs(s.score - expected) < 1e-9


def test_all_missing_gives_none():
    s = compute_score("0xb", 1, [], {}, None)
    assert s.score is None
    assert s.coverage == []
