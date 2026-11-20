"""EvidencePackage: the citable, stored-only context an investigation may
use. Anything not found lands in `missing`, never filled in."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class WalletSummary(BaseModel):
    address: str
    label: Optional[str] = None
    label_source: Optional[str] = None
    transfers_in: int = 0
    transfers_out: int = 0
    # Engine 3 enrichment — present only when wallet_scores rows exist
    score: Optional[float] = None
    score_coverage: Optional[list[str]] = None
    enrichment_source: Optional[str] = None  # e.g. "wallet_intelligence (engine 3)"


class EvidencePackage(BaseModel):
    trigger: dict  # {"tx_hash","chain_id","block_number"}
    transaction: Optional[dict] = None
    block: Optional[dict] = None
    logs: list[dict] = []
    transfers: list[dict] = []
    wallets: list[WalletSummary] = []
    hypotheses: list[dict] = []  # Engine 3 related-wallet hypotheses, when present
    missing: list[str] = []
    citable: list[dict] = []  # exact {tx_hash, block_number} pairs a report may cite
