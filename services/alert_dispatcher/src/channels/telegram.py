"""Telegram channel: Bot API sendMessage via TELEGRAM_BOT_TOKEN +
TELEGRAM_CHAT_ID. Unset token -> log-only 'skipped_no_config', never an
exception that stops the dispatcher."""
from __future__ import annotations

import logging
import os
from typing import Optional

import httpx

from models import AlertRecord


class TelegramChannel:
    name = "telegram"

    def __init__(self, log: logging.Logger, token: Optional[str] = None,
                 chat_id: Optional[str] = None,
                 transport: Optional[httpx.BaseTransport] = None):
        self.token = token if token is not None else os.getenv("TELEGRAM_BOT_TOKEN")
        self.chat_id = chat_id if chat_id is not None else os.getenv("TELEGRAM_CHAT_ID")
        self.log = log
        self.transport = transport

    def send(self, message: str, record: AlertRecord) -> str:
        if not self.token or not self.chat_id:
            self.log.info("telegram unconfigured; log-only", extra={"dedup_key": record.dedup_key})
            return "skipped_no_config"
        with httpx.Client(transport=self.transport, timeout=15) as client:
            r = client.post(
                f"https://api.telegram.org/bot{self.token}/sendMessage",
                json={"chat_id": self.chat_id, "text": message},
            )
            r.raise_for_status()
        return "sent"
