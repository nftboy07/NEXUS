"""Swap legs decoded from Engine 1's raw `logs` rows for pools registered in
Engine 4's `pools` table.

Engine 4's liquidity_events rows carry neither log_index nor out-amounts, so
they cannot order legs inside a block or reconstruct pre-trade prices. The
raw logs can: every leg here carries its log_index, in/out amounts, and the
pool price before/after the leg when it is derivable from stored logs:

  * V2 / Aerodrome volatile: the Sync emitted in the same tx right before the
    Swap gives post-trade reserves; pre-trade = post - in + out (exact).
    Aerodrome pools are skipped: pools rows do not record stable vs
    volatile, and stable pools are not constant-product.
  * V3: Swap carries sqrtPriceX96 after the trade; the price before is the
    previous stored V3 Swap on that pool (None when no earlier log stored).

Prices are token1 per token0 in raw units. Missing data stays None — never
guessed."""
from __future__ import annotations

from typing import Callable, Iterable, Optional

V2_SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822"
V3_SWAP = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67"
V2_SYNC = "0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1"
AERO_SWAP = "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b"
AERO_SYNC = "0xcf2aa50876cdfbb541206f89af0ee78d44a2abf8d328e37fa4917f982149848a"
SWAP_TOPICS = (V2_SWAP, V3_SWAP, AERO_SWAP)
SYNC_TOPICS = (V2_SYNC, AERO_SYNC)
DEX_TOPICS = SWAP_TOPICS + SYNC_TOPICS

Q96 = 2 ** 96


def _words(data: str) -> list[int]:
    d = data[2:] if data and data.startswith("0x") else (data or "")
    return [int(d[i:i + 64], 16) for i in range(0, len(d) - 63, 64)]


def _signed(w: int) -> int:
    return w - (1 << 256) if w >> 255 else w


def v3_price(sqrt_price_x96: int) -> float:
    return (sqrt_price_x96 / Q96) ** 2


def v2_price(reserve0: int, reserve1: int) -> Optional[float]:
    return reserve1 / reserve0 if reserve0 > 0 and reserve1 > 0 else None


def direction(leg: dict) -> int:
    """0 when token0 goes into the pool (sells token0), else 1."""
    return 0 if int(leg["amount0_in"]) > 0 else 1


def decode_legs(rows: Iterable[dict], prev_v3_sqrt: Callable[[str, int], Optional[int]]) -> list[dict]:
    """rows: logs joined with blocks/pools/transactions, ordered by
    (block_number, log_index). prev_v3_sqrt(pool_id, block) returns the last
    stored V3 sqrtPriceX96 for the pool strictly before `block` (or None).
    Returns ordered swap legs."""
    legs: list[dict] = []
    last_sync: dict[tuple[str, str], tuple[int, int, int]] = {}  # (tx, pool) -> (log_index, r0, r1)
    v3_last: dict[str, Optional[int]] = {}
    for r in rows:
        topics = [str(t).lower() for t in (r.get("topics") or [])]
        if not topics:
            continue
        t0 = topics[0]
        w = _words(r.get("data") or "0x")
        pool = r["pool_id"]
        block = int(r["block_number"])
        if t0 in SYNC_TOPICS and len(w) >= 2:
            last_sync[(r["tx_hash"], pool)] = (int(r["log_index"]), w[0], w[1])
            continue
        if t0 not in SWAP_TOPICS:
            continue
        leg = {
            "chain_id": int(r["chain_id"]), "block_number": block,
            "tx_hash": r["tx_hash"], "log_index": int(r["log_index"]),
            "pool_id": pool, "dex": r.get("dex"), "sender": r.get("sender"),
            "token0": r.get("token0"), "token1": r.get("token1"),
            "price_before": None, "price_after": None,
        }
        if t0 == V3_SWAP:
            if len(w) < 5:
                continue
            a0, a1, sqrt_after = _signed(w[0]), _signed(w[1]), w[2]
            leg.update(amm="v3", amount0_in=max(a0, 0), amount1_in=max(a1, 0),
                       amount0_out=max(-a0, 0), amount1_out=max(-a1, 0),
                       sqrt_price_after=sqrt_after)
            if pool not in v3_last:
                v3_last[pool] = prev_v3_sqrt(pool, block)
            before = v3_last[pool]
            leg["price_after"] = v3_price(sqrt_after)
            leg["price_before"] = v3_price(before) if before else None
            v3_last[pool] = sqrt_after
        else:
            if len(w) < 4:
                continue
            leg.update(amm="v2", amount0_in=w[0], amount1_in=w[1],
                       amount0_out=w[2], amount1_out=w[3])
            sync = last_sync.get((r["tx_hash"], pool))
            if sync and sync[0] < leg["log_index"] and r.get("dex") != "aerodrome":
                r0_after, r1_after = sync[1], sync[2]
                r0_before = r0_after - w[0] + w[2]
                r1_before = r1_after - w[1] + w[3]
                leg["reserves_after"] = [str(r0_after), str(r1_after)]
                leg["price_after"] = v2_price(r0_after, r1_after)
                leg["price_before"] = v2_price(r0_before, r1_before)
        if leg["amount0_in"] == 0 and leg["amount1_in"] == 0:
            continue
        legs.append(leg)
    return legs


def price_move_pct(leg: dict) -> Optional[float]:
    """|price_after / price_before - 1| in percent; None when not derivable."""
    b, a = leg.get("price_before"), leg.get("price_after")
    if not b or a is None:
        return None
    return abs(a / b - 1) * 100
