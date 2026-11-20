from arbitrage import find_arbitrage

from conftest import swap

P1, P2 = "1:uniswap_v2:0xp1", "1:sushiswap:0xp2"


def test_profitable_cycle_finding():
    legs = [
        swap("0x1", "0xarb", P1, 1000, 0),
        swap("0x2", "0xarb", P2, 0, 500),
        swap("0x3", "0xarb", P1, 0, 300),
    ]
    fs = find_arbitrage(legs, {P1, P2})
    assert len(fs) == 1
    assert fs[0].kind == "cyclic_arbitrage"
    assert "fees excluded" in fs[0].estimated_impact["note"]
    assert len(fs[0].evidence) == 3


def test_losing_cycle_no_finding():
    legs = [
        swap("0x1", "0xarb", P1, 1000, 0),
        swap("0x2", "0xarb", P2, 0, 1500),
    ]
    assert find_arbitrage(legs, {P1, P2}) == []


def test_single_pool_no_finding():
    legs = [swap("0x1", "0xarb", P1, 1000, 0), swap("0x2", "0xarb", P1, 0, 500)]
    assert find_arbitrage(legs, {P1, P2}) == []
