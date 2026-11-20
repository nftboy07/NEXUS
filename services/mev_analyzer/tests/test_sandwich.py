from blocks import analyze_block
from findings import RunStats
from sandwich import find_sandwiches

from conftest import swap

POOL = "1:uniswap_v2:0xpool"
RES = {"pool_id": POOL, "reserve0": 10_000_000, "reserve1": 20_000_000, "block_number": 100}


def test_planted_sandwich_one_finding(store):
    # A1 (attacker, token0->1), V (victim same direction), A2 (attacker back)
    legs = [
        swap("0xa1", "0xattacker", POOL, 500_000, 0),
        swap("0xv", "0xvictim", POOL, 100_000, 0),
        swap("0xa2", "0xattacker", POOL, 0, 900_000),
    ]
    findings, insuff = find_sandwiches(legs, lambda p, b: RES)
    assert insuff == 0
    assert len(findings) == 1
    f = findings[0]
    assert f.kind == "potential_sandwich"
    assert f.initiator == "0xattacker" and f.victim == "0xvictim"
    assert [e["tx_hash"] for e in f.evidence] == ["0xa1", "0xv", "0xa2"]
    assert f.estimated_impact["victim_impact_pct_estimate"] > 0.5
    assert "resemblance" in f.confidence.rationale or "never proven" in f.confidence.rationale


def test_no_closing_leg_no_finding(store):
    legs = [
        swap("0x1", "0xa", POOL, 500_000, 0),
        swap("0x2", "0xb", POOL, 100_000, 0),
    ]
    findings, _ = find_sandwiches(legs, lambda p, b: RES)
    assert findings == []


def test_missing_reserves_insufficient_evidence(store):
    legs = [
        swap("0xa1", "0xattacker", POOL, 500_000, 0),
        swap("0xv", "0xvictim", POOL, 100_000, 0),
        swap("0xa2", "0xattacker", POOL, 0, 900_000),
    ]
    findings, insuff = find_sandwiches(legs, lambda p, b: None)
    assert findings == []
    assert insuff == 1
