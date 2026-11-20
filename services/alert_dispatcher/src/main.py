"""Engine 7 dispatcher entrypoint (Crypto Relic): nexus:alerts consumer
group -> validate -> format -> deliver to configured channels."""
from __future__ import annotations

import json
import logging
import os
import signal
import sys
import time

import redis

from channels.discord import DiscordChannel
from channels.telegram import TelegramChannel
from channels.webhook import WebhookChannel
from consumer import Dispatcher
from store import PgDeliveryStore


def log() -> logging.Logger:
    class F(logging.Formatter):
        def format(self, r):
            return json.dumps({"ts": self.formatTime(r), "level": r.levelname.lower(),
                               "logger": "alert_dispatcher", "msg": r.getMessage(),
                               **{k: v for k, v in r.__dict__.items()
                                  if k not in logging.LogRecord("", 0, "", 0, "", (), None).__dict__}})

    lg = logging.getLogger("alert_dispatcher")
    h = logging.StreamHandler(); h.setFormatter(F()); lg.handlers = [h]
    lg.setLevel(os.getenv("LOG_LEVEL", "INFO").upper())
    return lg


def main() -> int:
    lg = log()
    r = redis.from_url(os.environ["REDIS_URL"], decode_responses=False)
    store = PgDeliveryStore(os.environ["DATABASE_URL"])
    channels = [TelegramChannel(lg), DiscordChannel(lg), WebhookChannel(lg)]
    d = Dispatcher(r, store, channels, consumer=os.getenv("CONSUMER_NAME", "dispatcher-1"), log=lg)
    d.ensure_group()

    stop = False
    def _sig(*_):
        nonlocal stop
        stop = True
    signal.signal(signal.SIGTERM, _sig)
    signal.signal(signal.SIGINT, _sig)

    lg.info("alert_dispatcher started", extra={"channels": [c.name for c in channels]})
    delivered = 0
    last_hb = 0.0
    while not stop:
        delivered += d.poll()
        if time.time() - last_hb >= 60:
            lg.info("heartbeat", extra={"delivered": delivered})
            last_hb = time.time()
    store.close()
    lg.info("alert_dispatcher stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
