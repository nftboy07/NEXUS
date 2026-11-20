"""Whale-threshold alert rules.

WHALE_THRESHOLD_ETH (env, default 100) applies to transfers of WETH (the
on-chain ETH proxy): amount in wei >= threshold*1e18 -> alert, with the
valuation source stated. Watchlist rows add two more rules:

  kind 'wallet'      value = address           -> alert on any transfer in/out
  kind 'min_amount'  value = '<token>:<amt>'   -> alert when amount >= amt
"""
from __future__ import annotations

from typing import Optional

from models import AlertRecord, TransferRecord

WETH: dict[int, str] = {
    1: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",   # Ethereum WETH
    8453: "0x4200000000000000000000000000000000000006",  # Base WETH
}
ETH = 10**18


def check_transfer(
    t: TransferRecord,
    watchlists: list[dict],
    whale_threshold_eth: float = 100.0,
) -> Optional[AlertRecord]:
    facts = {
        "tx_hash": t.tx_hash,
        "block_number": t.block_number,
        "token": t.token,
        "from": t.sender,
        "to": t.recipient,
        "amount": str(t.amount),
        "valuation_source": "token units only; no price feed configured",
    }

    watched = {w["value"].lower() for w in watchlists if w["kind"] == "wallet"}
    if t.sender in watched or t.recipient in watched:
        facts["rule"] = "watchlist wallet"
        facts["wallet"] = t.sender if t.sender in watched else t.recipient
        return AlertRecord(
            kind="whale_transfer",
            chain_id=t.chain_id,
            title=f"Watchlist wallet transfer on chain {t.chain_id}",
            facts=facts,
            dedup_key=f"wallet_intelligence:whale_transfer:{t.dedup_key}",
        )

    for w in watchlists:
        if w["kind"] != "min_amount":
            continue
        try:
            token, amt = w["value"].split(":")
        except ValueError:
            continue
        if t.token == token.lower() and t.amount >= int(amt):
            facts["rule"] = f"watchlist min_amount {amt}"
            return AlertRecord(
                kind="whale_transfer",
                chain_id=t.chain_id,
                title=f"Token transfer over watchlist threshold on chain {t.chain_id}",
                facts=facts,
                dedup_key=f"wallet_intelligence:whale_transfer:{t.dedup_key}",
            )

    weth = WETH.get(t.chain_id)
    if weth and t.token == weth and t.amount >= int(whale_threshold_eth * ETH):
        facts["rule"] = f"WHALE_THRESHOLD_ETH={whale_threshold_eth} (WETH as ETH proxy)"
        facts["valuation_source"] = "WETH transfer amount in wei (ETH units); no USD price source"
        return AlertRecord(
            kind="whale_transfer",
            chain_id=t.chain_id,
            title=f"Whale transfer >= {whale_threshold_eth} ETH on chain {t.chain_id}",
            facts=facts,
            dedup_key=f"wallet_intelligence:whale_transfer:{t.dedup_key}",
        )
    return None
