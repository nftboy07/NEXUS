"""Deterministic accumulation/distribution over a rolling window (default
7 days, env ACCUMULATION_WINDOW_DAYS). Net inflow/outflow per wallet+token
from wallet_transfers; buy/sell counts when the counterparty is a known DEX
pool (Engine 4 `pools` table), degrading to transfer-only signals otherwise —
the `signals_used` field always names which were used."""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from models import TransferRecord


@dataclass
class FlowStats:
    inflow: int = 0
    outflow: int = 0
    buys: int = 0  # received tokens FROM a known pool
    sells: int = 0  # sent tokens TO a known pool

    @property
    def net(self) -> int:
        return self.inflow - self.outflow


@dataclass
class AccumulationResult:
    wallet: str
    chain_id: int
    window_days: int
    signals_used: list[str]
    tokens: dict[str, FlowStats] = field(default_factory=dict)

    @property
    def accumulating(self) -> list[str]:
        return [t for t, s in self.tokens.items() if s.net > 0]

    @property
    def distributing(self) -> list[str]:
        return [t for t, s in self.tokens.items() if s.net < 0]


def compute_flows(
    transfers: list[TransferRecord],
    wallet: str,
    chain_id: int,
    window_days: int = 7,
    pool_addresses: set[str] | None = None,
) -> AccumulationResult:
    wallet = wallet.lower()
    pools = {a.lower() for a in (pool_addresses or set())}
    res = AccumulationResult(
        wallet=wallet,
        chain_id=chain_id,
        window_days=window_days,
        signals_used=["transfers"] + (["dex_pools"] if pools else []),
    )
    for t in transfers:
        stats = res.tokens.setdefault(t.token, FlowStats())
        if t.recipient == wallet:
            stats.inflow += t.amount
            if t.sender in pools:
                stats.buys += 1
        elif t.sender == wallet:
            stats.outflow += t.amount
            if t.recipient in pools:
                stats.sells += 1
    return res


def all_wallet_flows(
    transfers: list[TransferRecord],
    chain_id: int,
    window_days: int = 7,
    pool_addresses: set[str] | None = None,
) -> dict[str, AccumulationResult]:
    """Group a transfer set by wallet and compute flows for each."""
    wallets = defaultdict(list)
    for t in transfers:
        wallets[t.sender].append(t)
        wallets[t.recipient].append(t)
    return {
        w: compute_flows(ts, w, chain_id, window_days, pool_addresses)
        for w, ts in wallets.items()
    }
