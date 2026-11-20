"""Pydantic models for Engine 5 (MEV & transaction intelligence)."""
from __future__ import annotations

from typing import Any, Literal, Optional

from pydantic import BaseModel


class TxEvent(BaseModel):
    """One tx's observed DEX activity inside a block (from stored rows)."""
    hash: str
    sender: Optional[str] = None
    block_number: int
    position: int = 0  # order within the block
    # swap legs observed in liquidity_events: pool_id -> (amount0_in, amount1_in)
    swaps: list[dict] = []


class BlockTxSequence(BaseModel):
    chain_id: int
    block_number: int
    txs: list[TxEvent] = []


class Confidence(BaseModel):
    level: Literal["low", "medium", "high"]
    rationale: str


class Finding(BaseModel):
    kind: str  # potential_sandwich | cyclic_arbitrage | liquidation | gas_outlier
    chain_id: int
    block_number: int
    initiator: Optional[str] = None
    victim: Optional[str] = None
    pool_id: Optional[str] = None
    evidence: list[dict]  # tx hashes + block numbers, always
    estimated_impact: dict = {}
    confidence: Confidence


class ProtectionReport(BaseModel):
    chain_id: int
    pool_id: str
    token_in: str
    amount_in: int
    impact_pct: Optional[float]  # None when reserves missing/stale — never guessed
    slippage_warning: Optional[str] = None
    reserve_block: Optional[int] = None
    reserve_age_blocks: Optional[int] = None
    stale: bool = False
    note: Optional[str] = None
