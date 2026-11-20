"""Pydantic models for Engine 3 (wallet intelligence)."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel


class NormalizedEvent(BaseModel):
    """Subset of NexusNormalizedEvent (event.schema.json) this engine consumes."""

    chain_id: int
    kind: str
    dedup_key: str
    block_number: Optional[int] = None
    tx_hash: Optional[str] = None
    log_index: Optional[int] = None
    block_hash: Optional[str] = None
    payload: dict[str, Any] = {}


class TransferRecord(BaseModel):
    """A decoded ERC-20 Transfer (from a normalized log or transfer event)."""

    chain_id: int
    token: str
    sender: str
    recipient: str
    amount: int  # raw token units
    tx_hash: str
    block_number: int
    log_index: int
    dedup_key: str
    block_hash: Optional[str] = None


class WalletProfile(BaseModel):
    """Behavioral profile derived entirely from stored rows.

    Every field is computed from wallet_transfers/wallets rows; a field with
    no data is null, never estimated silently.
    """

    address: str
    chain_id: int
    label: Optional[str] = None
    label_source: Optional[str] = None
    first_seen_block: Optional[int] = None
    tx_count_in: int = 0
    tx_count_out: int = 0
    total_in_by_token: dict[str, int] = {}
    total_out_by_token: dict[str, int] = {}
    top_counterparties: list[str] = []
    funding_sources: list[str] = []  # first inbound senders (evidence, not labels)
    failed_tx_count: Optional[int] = None  # None when transactions table lacks data
    typical_tx_size: Optional[int] = None  # median transfer amount
    activity_span_blocks: Optional[int] = None


class ScoreComponent(BaseModel):
    value: Optional[float]  # 0..1, or None when data is insufficient
    evidence: dict[str, Any]


class ScoreComponents(BaseModel):
    realized_performance: ScoreComponent
    risk_adjusted_performance: ScoreComponent
    early_discovery: ScoreComponent
    consistency: ScoreComponent
    behavioral_reliability: ScoreComponent


class WalletScore(BaseModel):
    address: str
    chain_id: int
    score: Optional[float]  # weighted composite, renormalized over contributing components
    coverage: list[str]  # names of components that contributed a value
    components: ScoreComponents


class RelationSignal(BaseModel):
    kind: str  # shared_funding_source | same_token_window | direct_interaction | similar_pattern
    evidence: dict[str, Any]


class RelationHypothesis(BaseModel):
    """A related-wallet HYPOTHESIS — a clue, never a claim of common ownership."""

    kind: Literal["related_wallet_hypothesis"] = "related_wallet_hypothesis"
    address_a: str
    address_b: str
    chain_id: int
    signals: list[RelationSignal]
    confidence: str  # low | medium | high
    alternatives: list[str]
    description: str


class AlertRecord(BaseModel):
    source: str = "wallet_intelligence"
    kind: str
    chain_id: int
    title: str
    facts: dict[str, Any]
    dedup_key: str
