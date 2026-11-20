"""Discord channel: POST to DISCORD_WEBHOOK_URL; log-only
'skipped_no_config' when unset."""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

from models import AlertRecord


class DiscordChannel:
    name = "discord"

    def __init__(self, log: logging.Logger, webhook_url: Optional[str] = None,
                 transport: Optional[httpx.BaseTransport] = None):
        self.webhook_url = webhook_url if webhook_url is not None else os.getenv("DISCORD_WEBHOOK_URL")
        self.log = log
        self.transport = transport

    def send(self, message: str, record: AlertRecord) -> str:
        if not self.webhook_url:
            self.log.info("discord unconfigured; log-only", extra={"dedup_key": record.dedup_key})
            return "skipped_no_config"
        with httpx.Client(transport=self.transport, timeout=15) as client:
            r = client.post(self.webhook_url, json={"content": message})
            r.raise_for_status()
        return "sent"
