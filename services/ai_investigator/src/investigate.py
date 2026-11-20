"""Orchestration: package -> investigations row -> optional LLM call ->
schema parse -> mechanical citation validation -> store.

statuses: package_built | awaiting_model | complete | validation_failed |
llm_error | report_invalid. A validation_failed report is stored for
audit, clearly marked, never presented as verified.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Optional

import httpx
import psycopg

from cost import cost_estimate
from llm import ModelError, ModelNotConfigured, call_model
from package import build_package
from report_schema import InvestigationReport
from validate import validate

PROMPT_PATH = Path(__file__).resolve().parents[1] / "PROMPT.md"
OUTPUT_FORMAT = (
    "\n\nRespond with a single JSON object matching this schema exactly: "
    '{"findings":[{"kind":"fact|estimate|hypothesis","statement":"...",'
    '"citations":["0x..."]}],"citations":[{"tx_hash":"0x...","block_number":0}],'
    '"confidence":{"level":"low|medium|high","rationale":"..."},'
    '"alternative_explanations":[""],"missing_evidence":[""],"next_steps":[""]}'
)


def _insert(conn: psycopg.Connection, trigger: str, evidence: dict, status: str,
            chain_id: int, trigger_tx: str) -> int:
    cur = conn.execute(
        "INSERT INTO investigations (trigger, evidence, status, chain_id, trigger_tx) "
        "VALUES (%s,%s,%s,%s,%s) RETURNING id",
        (trigger, json.dumps(evidence), status, chain_id, trigger_tx))
    return cur.fetchone()[0]


def _update(conn: psycopg.Connection, inv_id: int, status: str, **cols) -> None:
    sets = ", ".join(f"{k}=%s" for k in cols)
    conn.execute(f"UPDATE investigations SET status=%s, {sets} WHERE id=%s",
                 (status, *cols.values(), inv_id))


def run_investigation(
    conn: psycopg.Connection,
    chain_id: int,
    tx_hash: str,
    transport: Optional[httpx.BaseTransport] = None,
    log: Optional[logging.Logger] = None,
    api_key: Optional[str] = None,
    model: Optional[str] = None,
) -> int:
    log = log or logging.getLogger("ai_investigator")
    pkg = build_package(conn, chain_id, tx_hash)
    inv_id = _insert(conn, "tx", pkg.model_dump(), "package_built", chain_id, tx_hash)
    conn.commit()
    log.info("evidence package built", extra={"investigation_id": inv_id, "missing": len(pkg.missing)})

    prompt = PROMPT_PATH.read_text() + OUTPUT_FORMAT
    try:
        resp = call_model(prompt, pkg.model_dump_json(), transport=transport,
                          api_key=api_key, model=model)
    except ModelNotConfigured:
        _update(conn, inv_id, "awaiting_model")
        conn.commit()
        log.info("no model configured; package-only mode", extra={"investigation_id": inv_id})
        return inv_id
    except ModelError as e:
        _update(conn, inv_id, "llm_error", findings=str(e))
        conn.commit()
        return inv_id

    cost = cost_estimate(resp["input_tokens"], resp["output_tokens"])
    try:
        raw = json.loads(resp["content"])
        report = InvestigationReport.model_validate(raw)
    except Exception as e:
        _update(conn, inv_id, "report_invalid", report=json.dumps({"raw": resp["content"], "error": str(e)}),
                input_tokens=resp["input_tokens"], output_tokens=resp["output_tokens"],
                cost_estimate=cost, model=resp["model"])
        conn.commit()
        return inv_id

    ok, problems = validate(report, pkg)
    status = "complete" if ok else "validation_failed"
    _update(
        conn, inv_id, status,
        report=json.dumps({"report": report.model_dump(), "validation_problems": problems,
                           "unverified": not ok}),
        citations_valid=ok,
        input_tokens=resp["input_tokens"],
        output_tokens=resp["output_tokens"],
        cost_estimate=cost,
        model=resp["model"],
        findings="; ".join(f.statement for f in report.findings[:3]),
    )
    conn.commit()
    log.info("investigation stored", extra={"id": inv_id, "status": status, "cost": cost})
    return inv_id
