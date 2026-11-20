"""WalletProfile construction — every field derived from stored rows; a
field with no data is null, never estimated silently."""
from __future__ import annotations

import statistics
from collections import Counter

from db import WalletStore
from models import WalletProfile


def build_profile(store: WalletStore, chain_id: int, address: str) -> WalletProfile:
    address = address.lower()
    rows = store.transfers_for(chain_id, address)
    label, label_source = store.get_wallet_label(address)

    tx_in = [r for r in rows if r["recipient"] == address]
    tx_out = [r for r in rows if r["sender"] == address]

    total_in: dict[str, int] = {}
    for r in tx_in:
        total_in[r["token"]] = total_in.get(r["token"], 0) + int(r["amount"])
    total_out: dict[str, int] = {}
    for r in tx_out:
        total_out[r["token"]] = total_out.get(r["token"], 0) + int(r["amount"])

    counterparties = Counter(
        r["sender"] for r in tx_in
    ) + Counter(r["recipient"] for r in tx_out)
    top = [a for a, _ in counterparties.most_common(5)]

    # funding sources: distinct senders of the wallet's first inbound transfers
    funding = []
    seen = set()
    for r in tx_in:
        if r["sender"] not in seen:
            seen.add(r["sender"])
            funding.append(r["sender"])
        if len(funding) >= 5:
            break

    blocks = [int(r["block_number"]) for r in rows]
    amounts = [int(r["amount"]) for r in rows]
    failed = store.failed_tx_count(chain_id, address)

    return WalletProfile(
        address=address,
        chain_id=chain_id,
        label=label,
        label_source=label_source,
        first_seen_block=min(blocks) if blocks else None,
        tx_count_in=len(tx_in),
        tx_count_out=len(tx_out),
        total_in_by_token=total_in,
        total_out_by_token=total_out,
        top_counterparties=top,
        funding_sources=funding,
        failed_tx_count=failed,
        typical_tx_size=int(statistics.median(amounts)) if amounts else None,
        activity_span_blocks=(max(blocks) - min(blocks)) if len(blocks) > 1 else None,
    )
