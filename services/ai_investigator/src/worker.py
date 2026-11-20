"""Worker mode: consumes 'queued' investigations rows (e.g. created by
POST /investigations) and runs the same package -> LLM -> validation
path as the CLI. Claims are atomic (FOR UPDATE SKIP LOCKED) so N workers
never process the same row. Without a configured model, rows land back
at 'awaiting_model' with zero HTTP calls; on startup with a model,
awaiting_model rows are re-queued. Rows stuck 'running' >10 min are
re-queued (crashed worker)."""
from __future__ import annotations

import logging
import os
import time
from typing import Optional

import httpx

from investigate import finish_investigation
from package import build_package

POLL_ENV = "INVESTIGATOR_POLL_SECONDS"
DEFAULT_POLL = 10.0
STALE_MINUTES = 10


def requeue(conn, model_configured: bool) -> dict:
    """Startup maintenance: stale 'running' claims and (only when a model
    is configured) 'awaiting_model' rows go back to 'queued'."""
    stale = conn.execute(
        "UPDATE investigations SET status='queued', updated_at=now() "
        "WHERE status='running' AND updated_at < now() - interval '%s minutes'"
        % STALE_MINUTES).rowcount
    awaiting = 0
    if model_configured:
        awaiting = conn.execute(
            "UPDATE investigations SET status='queued', updated_at=now() "
            "WHERE status='awaiting_model'").rowcount
    conn.commit()
    return {"stale_running": stale, "awaiting_model": awaiting}


def claim_next(conn) -> Optional[tuple]:
    """Atomically claim one queued row. Returns (id, chain_id, trigger_tx)."""
    row = conn.execute(
        "UPDATE investigations SET status='running', updated_at=now() "
        "WHERE id = (SELECT id FROM investigations WHERE status='queued' "
        "ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1) "
        "RETURNING id, chain_id, trigger_tx").fetchone()
    conn.commit()
    return row


def tick(conn, log: logging.Logger, transport: Optional[httpx.BaseTransport] = None,
         api_key: Optional[str] = None, model: Optional[str] = None) -> bool:
    """One work unit. Returns False when the queue was empty."""
    row = claim_next(conn)
    if not row:
        return False
    inv_id, chain_id, trigger_tx = row
    pkg = build_package(conn, chain_id, trigger_tx)
    conn.execute(
        "UPDATE investigations SET evidence=%s, status='package_built', updated_at=now() WHERE id=%s",
        (pkg.model_dump_json(), inv_id))
    conn.commit()
    finish_investigation(conn, inv_id, pkg, transport=transport, log=log,
                         api_key=api_key, model=model)
    log.info("worker processed investigation", extra={"id": inv_id})
    return True


def run_worker(conn, log: logging.Logger,
               transport: Optional[httpx.BaseTransport] = None) -> None:
    poll = float(os.getenv(POLL_ENV, DEFAULT_POLL))
    model_ready = bool(os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL"))
    rq = requeue(conn, model_ready)
    log.info("worker startup", extra={"poll_seconds": poll, "model_configured": model_ready,
                                      "requeued": rq})
    while True:
        try:
            if not tick(conn, log, transport=transport):
                time.sleep(poll)
        except Exception as e:
            log.error("worker tick failed", extra={"err": str(e)})
            try:
                conn.rollback()
            except Exception:
                pass
            time.sleep(poll)
