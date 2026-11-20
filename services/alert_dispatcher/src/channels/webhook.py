"""Signed webhooks: POST the alert JSON to ALERT_WEBHOOK_URLS
(comma-separated) with X-Nexus-Signature: sha256=<hmac> computed with
WEBHOOK_SECRET. Unset secret -> webhooks disabled (skipped_no_config) —
unsigned alerts are never sent."""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
from typing import Optional

import httpx

from models import AlertRecord


def sign(secret: str, body: bytes) -> str:
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


class WebhookChannel:
    name = "webhook"

    def __init__(self, log: logging.Logger, urls: Optional[str] = None,
                 secret: Optional[str] = None,
                 transport: Optional[httpx.BaseTransport] = None):
        raw = urls if urls is not None else os.getenv("ALERT_WEBHOOK_URLS", "")
        self.urls = [u.strip() for u in raw.split(",") if u.strip()]
        self.secret = secret if secret is not None else os.getenv("WEBHOOK_SECRET")
        self.log = log
        self.transport = transport

    def send(self, message: str, record: AlertRecord) -> str:
        if not self.secret:
            self.log.info("webhook secret unset; signed webhooks disabled",
                          extra={"dedup_key": record.dedup_key})
            return "skipped_no_config"
        if not self.urls:
            return "skipped_no_config"
        body = record.model_dump_json().encode()
        with httpx.Client(transport=self.transport, timeout=15) as client:
            for url in self.urls:
                r = client.post(url, content=body,
                                headers={"X-Nexus-Signature": sign(self.secret, body),
                                         "Content-Type": "application/json"})
                r.raise_for_status()
        return "sent"
