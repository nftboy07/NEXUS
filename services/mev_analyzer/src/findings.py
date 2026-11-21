"""Persist findings idempotently (unique on kind+block+initiator+pool),
emit alerts for high-confidence findings only (alerts row + nexus:alerts),
and keep run stats."""
from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field

from models import Finding

ALERTS_DESTINATION = "nexus:alerts"


@dataclass
class RunStats:
    blocks_analyzed: int = 0
    swap_legs: int = 0
    findings: dict[str, int] = field(default_factory=dict)
    insufficient_evidence: int = 0

    def summary(self) -> dict:
        return {
            "blocks_analyzed": self.blocks_analyzed,
            "swap_legs": self.swap_legs,
            "findings": self.findings,
            "insufficient_evidence": self.insufficient_evidence,
        }


def emit_finding_alert(store, redis_xadd, f: Finding, log: logging.Logger) -> bool:
    """High-confidence findings only. Returns True when emitted."""
    if f.confidence.level != "high":
        return False
    dedup_key = f"mev_analyzer:{f.kind}:{f.evidence[0]['tx_hash']}"
    record = {
        "source_engine": "mev_analyzer",
        "kind": f.kind,
        "chain_id": f.chain_id,
        "title": f"NEXUS by Crypto Relic — {f.kind} on chain {f.chain_id}",
        "facts": {"block_number": f.block_number, "initiator": f.initiator, "victim": f.victim,
                  "pool_id": f.pool_id, "evidence": f.evidence, "estimated_impact": f.estimated_impact,
                  "rationale": f.confidence.rationale},
        "assessment": {"confidence": f.confidence.level},
        "dedup_key": dedup_key,
    }
    message = json.dumps(record)
    if not store.insert_alert(record, message):
        return False
    if redis_xadd is not None:
        # same field shape as the other engines; alert_dispatcher reads 'record'
        redis_xadd(ALERTS_DESTINATION, {"dedup_key": dedup_key, "source_engine": "mev_analyzer",
                                        "kind": f.kind, "chain_id": str(f.chain_id), "record": message})
    if log:
        log.warning("mev alert emitted", extra={"kind": f.kind, "dedup_key": dedup_key})
    return True


def persist_findings(store, redis_xadd, findings: list[Finding], stats: RunStats, log: logging.Logger) -> int:
    written = 0
    for f in findings:
        if store.insert_finding(f):
            written += 1
            stats.findings[f.kind] = stats.findings.get(f.kind, 0) + 1
            emit_finding_alert(store, redis_xadd, f, log)
    return written
