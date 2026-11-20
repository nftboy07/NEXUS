"""Pydantic AlertRecord matching packages/event_schemas/alert.schema.json."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel


class Assessment(BaseModel):
    confidence: Optional[str] = None
    alternatives: list[Any] = []
    missing_info: list[Any] = []


class AlertRecord(BaseModel):
    source_engine: str
    kind: str
    chain_id: int
    title: Optional[str] = None
    facts: dict[str, Any]
    assessment: Optional[Assessment] = None
    dedup_key: str
    created_at: Optional[str] = None
