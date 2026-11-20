"""Persist findings idempotently (unique on kind+block+initiator+pool),
emit alerts for high-confidence findings only (alerts row + nexus:alerts),
and keep run stats."""
from __future__ import annotations

import logging
from dataclasses import dataclass, field

from models import Finding

ALERTS_DESTINATION = "nexus:alerts"


@dataclass
class RunStats:
    blocks_analyzed: int = 0
    findings: dict[str, int] = field(default_factory=dict)
    insufficient_evidence: int = 0

    def summary(self) -> dict:
        return {
            "blocks_analyzed": self.blocks_analyzed,
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
        "facts": {"evidence": f.evidence, "estimated_impact": f.estimated_impact},
        "assessment": {"confidence": f.confidence.level, "rationale": f.confidence.rationale},
        "dedup_key": dedup_key,
    }
    import json
    if not store.insert_alert(record, json.dumps(record)):
        return False
    if redis_xadd is not None:
        redis_xadd("nexus:alerts", {k: json.dumps(v) if isinstance(v, (dict, list)) else str(v)
                                  for k, v in record.items()})
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
