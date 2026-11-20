"""Decode normalized events into TransferRecords and persist them.

Accepts Engine 1 `transfer` events (decoded payload) and `log` events whose
topics match the ERC-20 Transfer signature — same record either way.
Idempotent on the wallet_transfers unique index.
"""
from __future__ import annotations

import logging
from typing import Optional

from db import WalletStore
from models import NormalizedEvent, TransferRecord

TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def decode_transfer(ev: NormalizedEvent) -> Optional[TransferRecord]:
    """Normalized event -> TransferRecord, or None for non-transfers."""
    p = ev.payload or {}
    if p.get("removed"):
        return None
    if ev.kind == "transfer" and {"token", "from", "to", "value"} <= set(p):
        return TransferRecord(
            chain_id=ev.chain_id,
            token=str(p["token"]).lower(),
            sender=str(p["from"]).lower(),
            recipient=str(p["to"]).lower(),
            amount=int(p["value"]),
            tx_hash=ev.tx_hash or "",
            block_number=ev.block_number or 0,
            log_index=ev.log_index or 0,
            dedup_key=ev.dedup_key,
            block_hash=ev.block_hash,
        )
    if ev.kind == "log":
        topics = p.get("topics") or []
        contract = p.get("contract")
        if len(topics) == 3 and str(topics[0]).lower() == TRANSFER_TOPIC0 and contract:
            return TransferRecord(
                chain_id=ev.chain_id,
                token=str(contract).lower(),
                sender="0x" + topics[1][-40:].lower(),
                recipient="0x" + topics[2][-40:].lower(),
                amount=int(str(p.get("data", "0x0")), 16),
                tx_hash=ev.tx_hash or "",
                block_number=ev.block_number or 0,
                log_index=ev.log_index or 0,
                dedup_key=ev.dedup_key,
                block_hash=ev.block_hash,
            )
    return None


def persist_transfer(store: WalletStore, t: TransferRecord, log: logging.Logger) -> bool:
    """Store one transfer + touch both wallets' first_seen. Returns True if new."""
    inserted = store.insert_transfer(t)
    if not inserted:
        log.info("duplicate transfer suppressed", extra={"dedup_key": t.dedup_key})
        return False
    store.upsert_wallet_first_seen(t.sender)
    store.upsert_wallet_first_seen(t.recipient)
    return True
