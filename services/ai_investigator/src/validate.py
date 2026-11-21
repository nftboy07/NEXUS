"""Mechanical honesty gate: every citation must be in the package's citable
index; every `fact` finding needs >=1 valid citation. Pure + deterministic.
"""
from __future__ import annotations

from evidence_schema import EvidencePackage
from report_schema import InvestigationReport


def validate(report: InvestigationReport, package: EvidencePackage) -> tuple[bool, list[str]]:
    citable = {(c["tx_hash"].lower(), int(c["block_number"])) for c in package.citable
               if c.get("tx_hash") and c.get("block_number") is not None}
    problems: list[str] = []
    for c in report.citations:
        if (c.tx_hash.lower(), c.block_number) not in citable:
            problems.append(f"citation not in evidence package: {c.tx_hash}@{c.block_number}")
    for f in report.findings:
        if f.kind == "fact":
            valid = any(h.lower() in {c[0] for c in citable} for h in f.citations)
            if not f.citations or not valid:
                problems.append(f"fact finding lacks a valid citation: {f.statement[:80]}")
    return len(problems) == 0, problems
