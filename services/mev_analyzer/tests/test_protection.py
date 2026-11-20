from protection import check_trade

POOL = "1:uniswap_v2:0xpool"
T0, T1 = "0xtoken0", "0xtoken1"


class Res:
    def __init__(self, row):
        self.row = row

    def reserves_at(self, pool_id, block):
        return self.row


def test_hand_computed_impact():
    # rIn=1_000_000, rOut=2_000_000, dx=10_000
    # out = 10000*997*2_000_000 / (1_000_000*10000 + 10000*997)
    #     = 19940000000000 / 10099700000 = 1974.3...
    # eff = out/dx = 0.19743; spot = 2.0; impact = (1 - 0.09871)*100 = 90.13%
    r = {"reserve0": 1_000_000, "reserve1": 2_000_000, "block_number": 95}
    rep = check_trade(POOL, T0, 10_000, T0, 100, Res(r), chain_id=1)
    assert rep.impact_pct is not None
    out = 10_000 * 997 * 2_000_000 / (1_000_000 * 10_000 + 10_000 * 997)
    expected = (1 - (out / 10_000) / 2.0) * 100
    assert abs(rep.impact_pct - expected) < 1e-6
    assert rep.slippage_warning is not None


def test_stale_reserves_null_impact():
    r = {"reserve0": 1_000_000, "reserve1": 2_000_000, "block_number": 10}
    rep = check_trade(POOL, T0, 10_000, T0, 500, Res(r), max_age_blocks=100)
    assert rep.impact_pct is None
    assert rep.stale is True
    assert "490" in rep.note or "old" in rep.note


def test_missing_reserves_null():
    rep = check_trade(POOL, T0, 10_000, T0, 100, Res(None))
    assert rep.impact_pct is None
    assert rep.note is not None
