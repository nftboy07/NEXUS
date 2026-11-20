"""Message formatter — BLUEPRINT §9: header (network, kind, status),
Facts section, Assessment section. Renders only fields present in the
record; absent assessment -> "No assessment supplied", never invented.
Mempool-sourced records show PENDING prominently.
"""
from __future__ import annotations

from models import AlertRecord

PENDING_SOURCES = {"mempool_listener"}


def format_alert(rec: AlertRecord) -> str:
    status = "PENDING" if rec.source_engine in PENDING_SOURCES else str(
        rec.facts.get("status") or "CONFIRMED")
    lines = [
        f"NEXUS by Crypto Relic — {rec.kind} on chain {rec.chain_id} [{status}]",
    ]
    if rec.title:
        lines.append(rec.title)
    lines.append("")
    lines.append("Facts")
    for k, v in rec.facts.items():
        lines.append(f"  {k}: {v}")
    lines.append("")
    lines.append("Assessment")
    if rec.assessment is None:
        lines.append("  No assessment supplied")
    else:
        a = rec.assessment
        if a.confidence:
            lines.append(f"  confidence: {a.confidence}")
        for x in a.alternatives:
            lines.append(f"  alternative: {x}")
        for x in a.missing_info:
            lines.append(f"  missing info: {x}")
        if not a.confidence and not a.alternatives and not a.missing_info:
            lines.append("  No assessment supplied")
    return "\n".join(lines)
