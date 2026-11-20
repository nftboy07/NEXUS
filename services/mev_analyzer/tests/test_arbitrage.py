from arbitrage import find_arbitrage

P1, P2, P3 = "1:0xp1", "1:0xp2", "1:0xp3"
WETH, USDC, DAI = "0xweth", "0xusdc", "0xdai"


def leg(tx, li, pool, t0, t1, a0in=0, a1in=0, a0out=0, a1out=0, sender="0xarb"):
    return {"tx_hash": tx, "log_index": li, "block_number": 100, "pool_id": pool, "sender": sender,
            "token0": t0, "token1": t1, "amount0_in": a0in, "amount1_in": a1in,
            "amount0_out": a0out, "amount1_out": a1out}


def test_profitable_cycle_finding():
    legs = [leg("0x1", 1, P1, USDC, WETH, a1in=1000, a0out=3000),   # WETH -> USDC
            leg("0x1", 3, P2, USDC, WETH, a0in=3000, a1out=1010)]   # USDC -> WETH
    [f] = find_arbitrage(legs, 1)
    assert f.kind == "cyclic_arbitrage" and f.initiator == "0xarb"
    assert f.pool_id == f"{P1},{P2}"
    assert f.estimated_impact["net_token_delta_estimate"] == {WETH: "10"}
    assert "fees excluded" in f.estimated_impact["note"]
    assert [e["log_index"] for e in f.evidence] == [1, 3]


def test_losing_cycle_no_finding():
    legs = [leg("0x1", 1, P1, USDC, WETH, a1in=1000, a0out=3000),
            leg("0x1", 3, P2, USDC, WETH, a0in=3000, a1out=990)]
    assert find_arbitrage(legs, 1) == []


def test_multihop_user_swap_not_arbitrage():
    # USDC -> WETH -> DAI: spends USDC, never closes the cycle
    legs = [leg("0x1", 1, P1, USDC, WETH, a0in=3000, a1out=1),
            leg("0x1", 2, P3, DAI, WETH, a1in=1, a0out=2990)]
    assert find_arbitrage(legs, 1) == []


def test_single_pool_no_finding():
    legs = [leg("0x1", 1, P1, USDC, WETH, a1in=1000, a0out=3000),
            leg("0x1", 2, P1, USDC, WETH, a0in=2000, a1out=1500)]
    assert find_arbitrage(legs, 1) == []


def test_separate_txs_not_combined():
    legs = [leg("0x1", 1, P1, USDC, WETH, a1in=1000, a0out=3000),
            leg("0x2", 3, P2, USDC, WETH, a0in=3000, a1out=1010)]
    assert find_arbitrage(legs, 1) == []
