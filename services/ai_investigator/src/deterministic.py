"""Deterministic template provider (LLM_PROVIDER=deterministic).

Free, offline, no HTTP: restates the evidence package as an
InvestigationReport so the full pipeline (package -> report -> citation
validation -> storage) runs without any model. It only restates stored
rows — every `fact` cites a tx/block from the package's citable index —
and makes no intent, attribution, or ownership claims. The report goes
through the same mechanical validator as model output.
"""
from __future__ import annotations

from evidence_schema import EvidencePackage
from report_schema import InvestigationReport

MODEL_NAME = "deterministic-template"
MAX_TRANSFERS = 20


def build_report(pkg: EvidencePackage) -> InvestigationReport:
    findings: list[dict] = []
    cited: dict[str, int] = {}

    def cite(tx: str, block) -> list[str]:
        if tx and block is not None:
            cited.setdefault(tx.lower(), int(block))
            return [tx.lower()]
        return []

    trig = pkg.trigger
    tx = pkg.transaction
    if tx:
        block = trig.get("block_number")
        findings.append({
            "kind": "fact",
            "statement": (f"Transaction {tx['hash']} on chain {trig['chain_id']} from "
                          f"{tx.get('sender')} to {tx.get('recipient')} was included in block "
                          f"{block} with status {tx.get('status')} and native value "
                          f"{tx.get('value')} wei."),
            "citations": cite(tx["hash"], block),
        })
        for a in pkg.alerts:
            rule = (a.get("record") or {}).get("facts", {}).get("rule")
            findings.append({
                "kind": "fact",
                "statement": (f"{a.get('source_engine')} raised a {a.get('kind')} alert "
                              f"(alert id {a.get('id')})"
                              + (f" under rule '{rule}'" if rule else "") + " for this transaction."),
                "citations": cite(tx["hash"], block),
            })
        for t in pkg.transfers[:MAX_TRANSFERS]:
            findings.append({
                "kind": "fact",
                "statement": (f"Token {t.get('token')} transfer of {t.get('amount')} raw units "
                              f"from {t.get('sender')} to {t.get('recipient')} in tx "
                              f"{t.get('tx_hash')} (block {t.get('block_number')})."),
                "citations": cite(t.get("tx_hash"), t.get("block_number")),
            })
        for w in pkg.wallets:
            if w.label:
                findings.append({
                    "kind": "fact",
                    "statement": f"Address {w.address} is labeled '{w.label}' (source: {w.label_source}).",
                    "citations": cite(tx["hash"], block),
                })
            if w.score is not None:
                findings.append({
                    "kind": "estimate",
                    "statement": (f"Engine 3 wallet score for {w.address} is {w.score} "
                                  f"(coverage: {w.score_coverage})."),
                    "citations": [],
                })
        for h in pkg.hypotheses:
            findings.append({
                "kind": "hypothesis",
                "statement": (f"Engine 3 relation hypothesis between {h.get('address_a')} and "
                              f"{h.get('address_b')} (signals: {h.get('signals')}); correlation "
                              "only, not proof of common ownership."),
                "citations": [],
            })

    missing = list(pkg.missing) + [
        "No model analysis performed (LLM_PROVIDER=deterministic): intent and attribution not assessed."]
    return InvestigationReport.model_validate({
        "findings": findings,
        "citations": [{"tx_hash": h, "block_number": b} for h, b in cited.items()],
        "confidence": {
            "level": "low",
            "rationale": ("Deterministic template: restates stored evidence only; no reasoning "
                          "about intent, ownership, or cause was applied."),
        },
        "alternative_explanations": [
            "Large or alerted transfers are frequently routine exchange, bridge, router, or "
            "market-maker operations; this template does not distinguish them.",
        ],
        "missing_evidence": missing,
        "next_steps": [
            "Configure LLM_BASE_URL/LLM_API_KEY/LLM_MODEL (e.g. a local Ollama endpoint) to "
            "re-run this investigation with model analysis.",
            "Review the cited transactions on a block explorer.",
        ],
    })
