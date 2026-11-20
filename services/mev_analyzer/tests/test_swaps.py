from conftest import v2_swap_row, v2_sync_row, v3_swap_row
from swaps import decode_legs, direction, price_move_pct

POOL = "1:0xpool"


def test_v2_pre_trade_reserves_reconstructed_from_sync():
    # pre (1000, 2000); token0 in 100 -> out 181 ; post (1100, 1819)
    rows = [v2_sync_row("0xa", 1, POOL, 1100, 1819), v2_swap_row("0xa", 2, POOL, "0xs", 100, 0, 0, 181)]
    [leg] = decode_legs(rows, lambda p, b: None)
    assert leg["price_before"] == 2000 / 1000
    assert leg["price_after"] == 1819 / 1100
    assert direction(leg) == 0 and leg["amount1_out"] == 181
    assert round(price_move_pct(leg), 4) == round(abs((1819 / 1100) / 2 - 1) * 100, 4)


def test_v2_without_sync_has_no_price():
    [leg] = decode_legs([v2_swap_row("0xa", 2, POOL, "0xs", 100, 0, 0, 181)], lambda p, b: None)
    assert leg["price_before"] is None and price_move_pct(leg) is None


def test_v3_price_before_from_previous_swap():
    q = 2 ** 96
    rows = [v3_swap_row("0xa", 1, POOL, "0xs", 100, -50, 2 * q), v3_swap_row("0xb", 5, POOL, "0xt", -10, 5, 3 * q)]
    a, b = decode_legs(rows, lambda p, blk: q)
    assert a["price_before"] == 1.0 and a["price_after"] == 4.0
    assert b["price_before"] == 4.0 and b["price_after"] == 9.0
    assert direction(a) == 0 and direction(b) == 1
    assert a["amount1_out"] == 50 and b["amount0_out"] == 10


def test_v3_without_history_is_insufficient():
    [leg] = decode_legs([v3_swap_row("0xa", 1, POOL, "0xs", 100, -50, 2 ** 96)], lambda p, b: None)
    assert leg["price_before"] is None


def test_aerodrome_reserves_not_used():
    rows = [v2_sync_row("0xa", 1, POOL, 1100, 1819, dex="aerodrome"),
            v2_swap_row("0xa", 2, POOL, "0xs", 100, 0, 0, 181, dex="aerodrome")]
    [leg] = decode_legs(rows, lambda p, b: None)
    assert leg["price_before"] is None
