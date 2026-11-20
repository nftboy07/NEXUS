from conftest import v2_swap_row, v2_trade
from sandwich import find_sandwiches
from swaps import decode_legs

POOL = "1:0xpool"
RES = (10_000_000, 20_000_000)


def legs_of(rows):
    return decode_legs(rows, lambda p, b: None)


def planted():
    rows = []
    r = v2_trade(rows, "0xa1", POOL, "0xattacker", RES, a0in=500_000)
    r = v2_trade(rows, "0xv", POOL, "0xvictim", r, a0in=100_000)
    # attacker sells back exactly what A1 bought (token1 in)
    bought = int(rows[1]["data"][2 + 64 * 3:2 + 64 * 4], 16)
    v2_trade(rows, "0xa2", POOL, "0xattacker", r, a1in=bought)
    return rows


def test_planted_sandwich_one_finding():
    findings, insuff = find_sandwiches(legs_of(planted()), 1)
    assert insuff == 0 and len(findings) == 1
    f = findings[0]
    assert f.kind == "potential_sandwich" and f.chain_id == 1 and f.pool_id == POOL
    assert f.initiator == "0xattacker" and f.victim == "0xvictim"
    assert [e["tx_hash"] for e in f.evidence] == ["0xa1", "0xv", "0xa2"]
    assert [e["role"] for e in f.evidence] == ["front_leg", "victim", "back_leg"]
    assert f.estimated_impact["victim_impact_pct_estimate"] > 0.5
    assert int(f.estimated_impact["initiator_gross_profit_estimate"]["raw_delta"]) > 0
    assert f.confidence.level == "high"
    assert "never proven" in f.confidence.rationale


def test_order_not_hash_decides():
    # same legs, rows shuffled: log_index ordering must still find it
    rows = planted()
    findings, _ = find_sandwiches(list(reversed(legs_of(rows))), 1)
    assert len(findings) == 1


def test_no_closing_leg_no_finding():
    rows = []
    r = v2_trade(rows, "0x1", POOL, "0xa", RES, a0in=500_000)
    v2_trade(rows, "0x2", POOL, "0xb", r, a0in=100_000)
    assert find_sandwiches(legs_of(rows), 1) == ([], 0)


def test_victim_opposite_direction_no_finding():
    rows = []
    r = v2_trade(rows, "0xa1", POOL, "0xattacker", RES, a0in=500_000)
    r = v2_trade(rows, "0xv", POOL, "0xvictim", r, a1in=100_000)
    v2_trade(rows, "0xa2", POOL, "0xattacker", r, a1in=900_000)
    assert find_sandwiches(legs_of(rows), 1)[0] == []


def test_small_price_move_below_threshold():
    rows = []
    r = v2_trade(rows, "0xa1", POOL, "0xattacker", RES, a0in=1_000)
    r = v2_trade(rows, "0xv", POOL, "0xvictim", r, a0in=1_000)
    v2_trade(rows, "0xa2", POOL, "0xattacker", r, a1in=1_000)
    assert find_sandwiches(legs_of(rows), 1) == ([], 0)


def test_missing_prices_insufficient_evidence():
    rows = [v2_swap_row("0xa1", 1, POOL, "0xattacker", 500_000, 0, 0, 900_000),
            v2_swap_row("0xv", 2, POOL, "0xvictim", 100_000, 0, 0, 150_000),
            v2_swap_row("0xa2", 3, POOL, "0xattacker", 0, 900_000, 480_000, 0)]
    findings, insuff = find_sandwiches(legs_of(rows), 1)
    assert findings == [] and insuff == 1
