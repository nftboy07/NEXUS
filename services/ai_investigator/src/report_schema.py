"""InvestigationReport schema. A report that fails validation is stored as
a failed run with raw output preserved (raw output never contains secrets).
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel


class Finding(BaseModel):
    kind: Literal["fact", "estimate", "hypothesis"]
    statement: str
    citations: list[str] = []  # tx hashes cited by this finding


class Citation(BaseModel):
    tx_hash: str
    block_number: int


class InvestigationReport(BaseModel):
    findings: list[Finding]
    citations: list[Citation]
    confidence: dict  # {"level": "...", "rationale": "..."}
    alternative_explanations: list[str] = []
    missing_evidence: list[str] = []
    next_steps: list[str] = []
